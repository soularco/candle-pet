import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, openSync, fstatSync, closeSync, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

/** relative() can return a drive-qualified path when Windows volumes differ. */
export function isOutside(parent: string, target: string): boolean {
  const part = relative(resolve(parent), resolve(target));
  return part === '..' || part.startsWith('..' + sep) || isAbsolute(part);
}

// Pass paths as environment data, never PowerShell source or shell interpolation.
const aclScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = $PSHOME + '\\Modules'
$p = $env:AAAAGENT_ACL_PATH
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$acl = Get-Acl -LiteralPath $p
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
# Elevated tokens can create files owned by their Administrators token owner.
# Admit that exact case, not arbitrary group owners or unelevated membership.
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$adminOwner = $owner -eq 'S-1-5-32-544' -and $owner -eq $identity.Owner.Value -and $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($owner -ne $sid.Value -and -not $adminOwner) { exit 2 }
if ($env:AAAAGENT_ACL_ACTION -eq 'restrict') {
  $item = Get-Item -LiteralPath $p -Force
  $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($id in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = [Security.Principal.SecurityIdentifier]::new($id)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($p, $acl) } else { [IO.File]::SetAccessControl($p, $acl) }
  $acl = Get-Acl -LiteralPath $p
}
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { exit 3 }
}
exit 0
`;
/**
 * Result cache for the Windows ACL probe.
 *
 * Every probe spawns PowerShell, which costs about 300 ms. Startup used to run
 * one probe per credential file per settings revision being validated, so the
 * same handful of files was checked ten-plus times and the pet spent ten seconds
 * of its launch doing work nobody could see. The cache is keyed on the file's
 * modification AND change times: on Windows the change time is updated whenever
 * a DACL is edited, so a permission change still invalidates the entry.
 */
const aclVerdicts = new Map<string, { mtimeMs: number; ctimeMs: number; size: number }>();

function aclVerdictFresh(key: string, filename: string): boolean {
  const cached = aclVerdicts.get(key);
  if (!cached) return false;
  try {
    const info = lstatSync(filename);
    return info.mtimeMs === cached.mtimeMs && info.ctimeMs === cached.ctimeMs && info.size === cached.size;
  } catch { return false; }
}

function rememberAclVerdict(key: string, filename: string): void {
  try {
    const info = lstatSync(filename);
    aclVerdicts.set(key, { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size });
    // Bound the map; a session never legitimately holds thousands of entries.
    if (aclVerdicts.size > 512) aclVerdicts.delete(aclVerdicts.keys().next().value as string);
  } catch { /* an unreadable file simply will not be cached */ }
}

function windowsAcl(filename: string, action: 'check' | 'restrict'): void {
  const cacheKey = action + '\u0000' + resolve(filename);
  if (aclVerdictFresh(cacheKey, filename)) return;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  try { execFileSync(win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclScript, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10000, stdio: 'pipe', env: { ...process.env, AAAAGENT_ACL_PATH: resolve(filename), AAAAGENT_ACL_ACTION: action } }); }
  catch (error) {
    // Expose only fixed failure categories, never subprocess output, paths or file contents.
    const failure = error as { status?: number; code?: string };
    const reason = failure.status === 2 ? 'owner_mismatch'
      : failure.status === 3 ? 'broad_access'
      : failure.code === 'ETIMEDOUT' ? 'timeout' : 'powershell_failure';
    throw Error(`Windows could not verify or restrict this owned file (${reason}). Check its owner and access permissions.`);
  }
  rememberAclVerdict(cacheKey, filename);
}
/** Metadata only. No credential contents are read. Windows checks SID-based DACLs. */
export function isPrivateFileSync(filename: string, opened?: Stats): boolean {
  try {
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    if (opened) {
      // Some Windows Node/libuv versions report dev=0 for path-based stat,
      // but a volume serial for fstat. Compare two handles on that platform;
      // never drop the device check or read credential contents.
      let identity = info;
      if (process.platform === 'win32' && info.dev !== opened.dev) {
        const fd = openSync(filename, 'r');
        try { identity = fstatSync(fd); } finally { closeSync(fd); }
      }
      if (identity.dev !== opened.dev || identity.ino !== opened.ino) return false;
    }
    if (process.platform === 'win32') windowsAcl(filename, 'check');
    else if ((info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) return false;
    return true;
  } catch { return false; }
}
/** Use only for files/directories created by this application or explicitly selected by the user. */
export function restrictPrivatePathSync(filename: string): void {
  const info = lstatSync(filename);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw Error('Expected an ordinary owned path');
  if (process.platform === 'win32') windowsAcl(filename, 'restrict');
  else chmodSync(filename, info.isDirectory() ? 0o700 : 0o600);
}
