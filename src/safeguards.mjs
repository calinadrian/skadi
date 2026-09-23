// Auto-mode safeguards, Claude-style. Auto mode runs actions without review,
// so anything destructive, outward-facing or hard to reverse is pulled back to
// the approval prompt instead. Rules are deliberately conservative: a false
// alarm costs one click, a miss can cost the user's data.

const COMMAND_RULES = [
  // Destructive file operations
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|--force)\b/i, 'recursive or forced delete'],
  [/\b(Remove-Item|ri|rd|rmdir|del|erase)\b[^|;&]*(-Recurse|\/s\b|-Force)/i, 'recursive or forced delete'],
  [/\b(format|diskpart|mkfs(\.\w+)?|dd\s+if=)\b/i, 'disk formatting or raw disk write'],
  [/\b(Clear-RecycleBin|cipher\s+\/w|shred|sdelete)\b/i, 'permanent data wipe'],
  // Git history / remote changes
  [/\bgit\s+push\b/i, 'pushes to a remote'],
  [/\bgit\s+reset\s+--hard\b/i, 'discards uncommitted work'],
  [/\bgit\s+clean\s+-[a-z]*[fdx]/i, 'deletes untracked files'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, 'discards uncommitted work'],
  [/\bgit\s+(branch\s+-D|tag\s+-d|filter-branch|filter-repo|rebase)\b/i, 'rewrites or deletes git history'],
  [/\bgit\s+(config\s+--global|remote\s+(add|set-url|remove))\b/i, 'changes git configuration'],
  // Publishing / deploying
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdotnet\s+nuget\s+push\b/i, 'publishes a package'],
  [/\bgh\s+(pr\s+(create|merge|close)|release\s+create|repo\s+(delete|create|edit)|issue\s+(create|close|comment))\b/i, 'acts on GitHub'],
  [/\b(vercel|netlify|firebase|fly|heroku|kubectl|terraform|helm)\b.*\b(deploy|apply|destroy|delete|up|--prod)\b/i, 'deploys or changes infrastructure'],
  // Download-and-execute, untrusted code
  [/\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^\n]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|python|node|pwsh|powershell)\b/i, 'downloads and executes code'],
  [/\b(iex|Invoke-Expression)\b.*\b(DownloadString|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/i, 'downloads and executes code'],
  [/-EncodedCommand\b|\s-enc\s/i, 'runs an encoded (hidden) command'],
  // Outbound data
  [/\b(curl|wget)\b[^\n]*\s(-d|--data\S*|-F|--form|-T|--upload-file|-X\s*(POST|PUT|DELETE|PATCH))\b/i, 'sends data to an external service'],
  [/\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n]*-Method\s+(Post|Put|Delete|Patch)/i, 'sends data to an external service'],
  [/\b(scp|rsync|sftp|ftp)\b/i, 'transfers files to another machine'],
  // System / security settings
  [/\b(reg\s+(add|delete|import)|Set-ItemProperty\s+[^\n]*HK(LM|CU)|New-ItemProperty\s+[^\n]*HK(LM|CU)|Remove-ItemProperty)\b/i, 'modifies the registry'],
  [/\b(Set-ExecutionPolicy|Set-MpPreference|Add-MpPreference|netsh|New-NetFirewallRule|Set-NetFirewallProfile|bcdedit|icacls|takeown|chmod\s+-R\s+777|chown\s+-R)\b/i, 'changes system or security settings'],
  [/\b(sudo|runas|Start-Process\b[^\n]*-Verb\s+RunAs)\b/i, 'elevates privileges'],
  [/\b(schtasks\s+\/create|Register-ScheduledTask|crontab\s+-|New-Service|sc(\.exe)?\s+(create|delete|config)|systemctl\s+(enable|disable|stop|mask))\b/i, 'creates persistent jobs or services'],
  [/\b(shutdown|Restart-Computer|Stop-Computer|reboot|halt)\b/i, 'shuts down or restarts the machine'],
  [/\b(Stop-Process|taskkill|kill|pkill|killall)\b[^\n]*(-Name|\/IM|\s-9|\s-f)/i, 'kills processes by name'],
  [/\b(net\s+user|net\s+localgroup|New-LocalUser|Add-LocalGroupMember|passwd|useradd|usermod)\b/i, 'manages user accounts'],
  // Global installs
  [/\b(npm|pnpm|yarn)\s+(i|install|add)\b[^\n]*(\s-g\b|--global)|\bpip\s+install\b[^\n]*--user|\b(winget|choco|scoop|apt|apt-get|brew)\s+(install|uninstall|upgrade)\b/i, 'installs or removes system software'],
  // Credentials
  [/\b(cmdkey|Get-Credential|ConvertFrom-SecureString|security\s+find-generic-password)\b/i, 'touches stored credentials'],
  [/(\.ssh[\\/]|id_rsa|id_ed25519|\.aws[\\/]credentials|\.npmrc|\.git-credentials|\.netrc)/i, 'touches credentials or keys'],
];

const SENSITIVE_PATHS = [
  [/(^|[\\/])\.env(\.|$)/i, 'environment secrets file'],
  [/(^|[\\/])\.git[\\/]/i, 'git internals'],
  [/(^|[\\/])\.ssh[\\/]|id_rsa|id_ed25519/i, 'SSH keys'],
  [/(^|[\\/])(\.npmrc|\.netrc|\.git-credentials|credentials(\.json)?)$/i, 'credentials file'],
  [/\.(pem|key|pfx|p12)$/i, 'private key or certificate'],
  [/^([a-z]:)?[\\/](windows|program files|etc|usr|bin|system32)([\\/]|$)/i, 'system location'],
];

function commandRisk(command) {
  const text = String(command || '');
  for (const [re, reason] of COMMAND_RULES) if (re.test(text)) return reason;
  return null;
}

function pathRisk(p) {
  const text = String(p || '').trim();
  if (!text) return null;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(text)) return 'path outside the workspace';
  for (const [re, reason] of SENSITIVE_PATHS) if (re.test(text)) return reason;
  return null;
}

/**
 * Decide whether an auto-approved action should go back to the user.
 * Returns a short reason string when the action is risky, or null when it
 * may run unreviewed.
 */
export function autoModeRisk(name, args = {}) {
  if (name === 'run_command') return commandRisk(args.command);
  for (const key of ['path', 'from', 'to', 'source', 'destination', 'target']) {
    const reason = pathRisk(args?.[key]);
    if (reason) return reason;
  }
  if (/^(delete|remove)_/.test(name)) return 'deletes files';
  return null;
}

// ---------------------------------------------------------------------------
// Plain-language summaries for the approval card, so the user can tell what
// an action does without reading raw JSON or shell syntax.

const COMMAND_HINTS = [
  [/^git\s+status\b/i, 'Show which files have changed in git'],
  [/^git\s+diff\b/i, 'Show uncommitted changes in git'],
  [/^git\s+log\b/i, 'Show git commit history'],
  [/^git\s+add\b/i, 'Stage files for the next git commit'],
  [/^git\s+commit\b/i, 'Create a git commit with the staged changes'],
  [/^git\s+push\b/i, 'Upload local commits to the remote repository'],
  [/^git\s+pull\b/i, 'Download and merge changes from the remote repository'],
  [/^git\s+(checkout|switch)\b/i, 'Switch git branch or restore files'],
  [/^git\s+reset\s+--hard\b/i, 'Throw away all uncommitted changes in git'],
  [/^git\s+clean\b/i, 'Delete untracked files from the project'],
  [/^git\s+stash\b/i, 'Set uncommitted changes aside in git'],
  [/^git\s+merge\b/i, 'Merge another branch into the current one'],
  [/^git\s+rebase\b/i, 'Rewrite git history onto another branch'],
  [/^git\b/i, 'Run a git command'],
  [/^(npm|pnpm|yarn)\s+(test|t)\b|^node\s+--test\b|^(pytest|jest|vitest|cargo\s+test|go\s+test|dotnet\s+test)\b/i, 'Run the test suite'],
  [/^(npm|pnpm|yarn)\s+(i|install|add|ci)\b|^pip\s+install\b/i, 'Install packages'],
  [/^(npm|pnpm|yarn)\s+run\s+build\b|^(cargo|dotnet|go)\s+build\b|^(make|msbuild|tsc)\b/i, 'Build the project'],
  [/^(npm|pnpm|yarn)\s+(run\s+)?(dev|start)\b/i, 'Start the app / dev server'],
  [/^(npm|pnpm|yarn)\s+publish\b/i, 'Publish a package to the public registry'],
  [/^(node|python|py|deno|bun)\b/i, 'Run a script'],
  [/^(rm|del|erase|Remove-Item|ri|rd|rmdir)\b/i, 'Delete files or folders'],
  [/^(mv|move|Move-Item|ren|rename|Rename-Item)\b/i, 'Move or rename files'],
  [/^(cp|copy|Copy-Item|xcopy|robocopy)\b/i, 'Copy files'],
  [/^(mkdir|md|New-Item)\b/i, 'Create files or folders'],
  [/^(ls|dir|Get-ChildItem|gci|tree)\b/i, 'List files'],
  [/^(cat|type|Get-Content|gc|head|tail|more)\b/i, 'Read a file'],
  [/^(grep|rg|findstr|Select-String|sls|find)\b/i, 'Search files'],
  [/^(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b/i, 'Make a web request'],
  [/^(Stop-Process|taskkill|kill|pkill)\b/i, 'Stop running programs'],
  [/^(winget|choco|scoop|apt|apt-get|brew)\b/i, 'Install or change system software'],
  [/^(reg|Set-ItemProperty|New-ItemProperty)\b/i, 'Change Windows registry settings'],
  [/^gh\b/i, 'Run a GitHub CLI command'],
  [/^Get-Date\b|^date\b/i, 'Check the current date and time'],
  [/^(Get-Process|ps|tasklist)\b/i, 'List running programs'],
  [/^(Get-Location|pwd|cd|Set-Location|sl)\b/i, 'Check or change the current folder'],
  [/^(echo|Write-Output|Write-Host)\b/i, 'Print some text'],
  [/^(Get-|Test-|Resolve-|Measure-|Select-|Format-|where\b|which\b)/i, 'Look up information (read-only)'],
  [/^docker\b/i, 'Run a Docker command'],
];

const clip = (s, n = 80) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const lines = (s) => (s ? String(s).split('\n').length : 0);

function describeCommand(command) {
  // Describe each step of a chained command ("a && b; c").
  const steps = String(command || '')
    .split(/\s*(?:&&|\|\||;|\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts = steps.map((step) => {
    const hit = COMMAND_HINTS.find(([re]) => re.test(step));
    return hit ? hit[1] : `Run the ${clip(step.split(/\s+/)[0], 40)} program`;
  });
  const unique = [...new Set(parts)];
  return unique.length
    ? unique.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join(', then ')
    : 'Run a shell command';
}

/** One or two plain sentences describing what a tool call will do. */
export function describeAction(name, args = {}) {
  const a = args || {};
  switch (name) {
    case 'run_command': {
      const where = a.background ? ' in the background' : '';
      return `${describeCommand(a.command)}${where}.`;
    }
    case 'write_file': {
      const n = lines(a.content);
      return `Create or overwrite the file ${a.path} (${n} line${n === 1 ? '' : 's'}). Any existing content in that file is replaced.`;
    }
    case 'edit_file': {
      const removed = lines(a.old_string), added = lines(a.new_string);
      const scope = a.replace_all ? 'every occurrence of' : 'one passage in';
      return `Edit ${a.path}: replace ${scope} a ${removed}-line block with ${added} new line${added === 1 ? '' : 's'}.`;
    }
    case 'delete_file':
      return `Delete ${a.path} from the project.`;
    case 'remember':
      return `Save a memory "${a.name}" for future sessions: ${clip(a.description || a.content)}`;
    case 'forget':
      return `Delete the saved memory "${a.name}".`;
    case 'save_skill':
      return `Save a reusable skill "${a.name}": ${clip(a.description)}`;
    case 'pixel_export':
      return `Export pixel art ${a.name ? `"${a.name}" ` : ''}as an image file to ${a.path}.`;
    case 'task_stop':
      return `Stop the background task ${a.task_id}.`;
    default: {
      const target = a.path || a.name;
      return `Use the ${name} tool${target ? ` on ${target}` : ''}.`;
    }
  }
}
