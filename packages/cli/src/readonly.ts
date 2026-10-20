/**
 * 远程 MCP 的只读模式：只放行查看类命令（状态、日志、磁盘、进程、网络、容器……），会改动服务器的一律拒绝。
 * 这是尽力而为的护栏，不是 Shell 沙箱：按词切开命令（认引号与转义），每一段的命令名要在清单里、参数也要过各自的规则；
 * 认不准的一律拒绝（宁可错拒，不可错放）。
 * - 拒绝：命令替换（`…`、$(…)、<(…)、>(…)）、子 Shell 与分组、heredoc、写文件的重定向（只允许到 /dev/null 与 2>&1 这类复制）、
 *   变量或通配符当命令名、不在标准目录（/bin、/usr/bin……）下的程序
 * - 允许：; && || | & 连接的多段命令、读文件的 <、cd、行首的变量赋值；sudo / timeout / nice / env / command 后面的命令照样检查
 */

export type ReadOnlyVerdict = { ok: true } | { ok: false; reason: string };

const MAX_COMMAND = 16_000;
const STANDARD_DIRS = new Set(['/bin', '/usr/bin', '/sbin', '/usr/sbin', '/usr/local/bin', '/usr/local/sbin']);

type Token = { word: string } | { op: string };

class Refuse extends Error {}
const refuse = (reason: string): never => {
  throw new Refuse(reason);
};

// ---------- 切词 ----------

const OPS_3 = ['<<<', '&>>', '<<-'];
const OPS_2 = ['&&', '||', '|&', ';;', '>>', '<<', '&>', '>&', '<&', '<>', '>|'];

function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  const n = command.length;
  let word = '';
  let inWord = false;
  const push = () => {
    if (inWord) tokens.push({ word });
    word = '';
    inWord = false;
  };
  let i = 0;
  while (i < n) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) refuse('引号没有配对');
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '$' && command[i + 1] === "'") {
      // $'…'：内容按原样（不解转义），只用来判断
      let j = i + 2;
      while (j < n && command[j] !== "'") j += command[j] === '\\' ? 2 : 1;
      if (j >= n) refuse('引号没有配对');
      word += command.slice(i + 2, j);
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        const d = command[j];
        if (d === '\\' && j + 1 < n) {
          word += command[j + 1];
          j += 2;
          continue;
        }
        if (d === '`' || (d === '$' && command[j + 1] === '(')) refuse('不允许命令替换（`…` 或 $(…)）');
        word += d;
        j++;
      }
      if (j >= n) refuse('引号没有配对');
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      if (command[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < n) word += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (c === '`' || (c === '$' && command[i + 1] === '(')) refuse('不允许命令替换（`…` 或 $(…)）');
    if (c === '#' && !inWord) {
      while (i < n && command[i] !== '\n') i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      push();
      i++;
      continue;
    }
    if (c === '\n') {
      push();
      tokens.push({ op: ';' });
      i++;
      continue;
    }
    if (';&|()<>'.includes(c)) {
      if ((c === '<' || c === '>') && command[i + 1] === '(') refuse('不允许进程替换（<(…) 或 >(…)）');
      const three = command.slice(i, i + 3);
      const two = command.slice(i, i + 2);
      const op = OPS_3.includes(three) ? three : OPS_2.includes(two) ? two : c;
      // 2>/dev/null 的 2 是文件描述符，不是参数
      if ((op[0] === '<' || op[0] === '>') && inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else push();
      tokens.push({ op });
      i += op.length;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  push();
  return tokens;
}

/** 切成一段段命令（; && || | & 隔开），同时检查重定向 */
function segments(tokens: Token[]): string[][] {
  const result: string[][] = [];
  let current: string[] = [];
  const next = (index: number): string => {
    const token = tokens[index];
    if (!token || !('word' in token)) refuse('重定向后面缺少目标');
    return (token as { word: string }).word;
  };
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if ('word' in token) {
      current.push(token.word);
      continue;
    }
    const { op } = token;
    if ([';', '&&', '||', '|', '|&', '&'].includes(op)) {
      if (current.length) result.push(current);
      current = [];
    } else if (op === '(' || op === ')') {
      refuse('不支持子 Shell 与分组 ( … )');
    } else if (op === ';;') {
      refuse('不支持 case 语句');
    } else if (op === '>&' || op === '<&') {
      // 2>&1、>&2：复制文件描述符
      if (!/^(\d+|-)$/.test(next(k + 1))) refuse('不允许写文件（重定向）');
      k++;
    } else if (['>', '>>', '>|', '&>', '&>>'].includes(op)) {
      const target = next(k + 1);
      if (!['/dev/null', '/dev/stdout', '/dev/stderr'].includes(target)) refuse(`不允许写文件（重定向到 ${target}）`);
      k++;
    } else if (op === '<' || op === '<<<') {
      next(k + 1);
      k++;
    } else if (op === '<<' || op === '<<-') {
      refuse('不支持 heredoc');
    } else if (op === '<>') {
      refuse('不允许以读写方式打开文件');
    } else {
      refuse(`不支持 ${op}`);
    }
  }
  if (current.length) result.push(current);
  return result;
}

// ---------- 规则 ----------

type Rule = (args: string[]) => void;

const any: Rule = () => undefined;

/** 有这些参数（或短参数里带这些字母）就拒绝 */
function denyFlags(long: string[], shortLetters = '', what = '会改动服务器或一直不退出的参数'): Rule {
  return (args) => {
    for (const arg of args) {
      if (arg === '--') break;
      const name = arg.split('=')[0];
      if (long.includes(name)) refuse(`${what}：${arg}`);
      if (shortLetters && /^-[A-Za-z]/.test(arg) && !arg.startsWith('--')) {
        // -fn100 这类组合：数字之前的字母都是开关
        const letters = /^-([A-Za-z]+)/.exec(arg)?.[1] ?? '';
        for (const letter of letters) if (shortLetters.includes(letter)) refuse(`${what}：${arg}`);
      }
    }
  };
}

/** 第一个非选项参数（子命令）要在清单里；没有子命令时 allowEmpty 决定 */
function subcommands(allowed: string[], options: { allowEmpty?: boolean; valueOptions?: string[]; then?: Record<string, Rule> } = {}): Rule {
  return (args) => {
    let index = 0;
    while (index < args.length && args[index].startsWith('-')) {
      if (options.valueOptions?.includes(args[index])) index++;
      index++;
    }
    const sub = args[index];
    if (sub === undefined) {
      if (options.allowEmpty) return;
      refuse('缺少子命令');
    }
    if (!allowed.includes(sub)) refuse(`只读模式只允许这些子命令：${allowed.join('、')}（不允许 ${sub}）`);
    options.then?.[sub]?.(args.slice(index + 1));
  };
}

const versionOnly: Rule = (args) => {
  if (args.length === 1 && ['--version', '-v', '-V', 'version', '-version', '--help', '-h'].includes(args[0])) return;
  refuse('只允许查看版本（--version）');
};

const noFollow = denyFlags(['--follow', '--retry'], 'fF', '会一直不退出的参数');

/** awk：程序（第一个非选项参数）里不能有 system、getline、重定向与管道；不能从文件读程序或加载扩展 */
const awkRule: Rule = (args) => {
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (arg === '-i' || arg.startsWith('--include') || arg === '-f' || arg.startsWith('--file') || arg === '-l' || arg.startsWith('--load')) refuse(`不允许 awk 的 ${arg}`);
    if (arg === '-F' || arg === '-v') {
      k++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (/system|getline|[>|]/.test(arg)) refuse('awk 程序里不允许 system、getline、重定向与管道');
    return;
  }
};

const sedRule: Rule = (args) => {
  for (const arg of args) {
    if (/^-[A-Za-z]*i/.test(arg) && !arg.startsWith('--')) refuse('不允许 sed -i（改文件）');
    if (arg.startsWith('--in-place') || arg === '-f' || arg.startsWith('--file')) refuse(`不允许 sed 的 ${arg}`);
    // w 文件、e 命令：写文件或执行命令
    if (!arg.startsWith('-') && /(^|[;{}\n]|\/[gpiImMe0-9]*)\s*[wWe](\s|$)/.test(arg)) refuse('sed 脚本里不允许 w（写文件）与 e（执行命令）');
  }
};

const findRule = denyFlags(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'], '', '会改动或执行命令的 find 参数');

const topRule: Rule = (args) => {
  const joined = args.join(' ');
  if (!/(^|\s)-[A-Za-z]*b/.test(joined) || !/(^|\s)-[A-Za-z]*n/.test(joined)) refuse('top 要带 -b -n1（只输出一次）');
};

const curlRule: Rule = (args) => {
  const longDeny = ['--output', '--remote-name', '--remote-name-all', '--upload-file', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '--form', '--form-string', '--config', '--cookie-jar', '--dump-header', '--output-dir', '--create-dirs', '--trace', '--trace-ascii', '--libcurl', '--stderr', '--request', '--remote-header-name', '--etag-save', '--hsts', '--alt-svc'];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    const name = arg.split('=')[0];
    if (longDeny.includes(name)) {
      if (name === '--request' && /^(GET|HEAD)$/i.test(arg.includes('=') ? arg.split('=')[1] : (args[k + 1] ?? ''))) continue;
      refuse(`curl 只读模式不允许 ${name}（写文件或发数据）`);
    }
    if (/^-[A-Za-z]/.test(arg) && !arg.startsWith('--')) {
      const letters = /^-([A-Za-z]+)/.exec(arg)?.[1] ?? '';
      for (const letter of letters) {
        if (letter === 'X') {
          const method = letters.endsWith('X') ? (arg.length > letters.length + 1 ? arg.slice(letters.length + 1) : args[k + 1] ?? '') : '';
          if (!/^(GET|HEAD)$/i.test(method)) refuse('curl 只读模式只允许 GET / HEAD');
          continue;
        }
        if ('oOTdFKcDJ'.includes(letter)) refuse(`curl 只读模式不允许 -${letter}（写文件或发数据）`);
      }
    }
  }
};

const ipRule: Rule = (args) => {
  const words = ['add', 'del', 'delete', 'change', 'chg', 'replace', 'set', 'flush', 'append', 'prepend', 'save', 'restore', 'monitor', 'exec', 'attach', 'detach', 'update', 'shutdown', 'reset'];
  for (const arg of args) if (words.includes(arg)) refuse(`ip 只读模式不允许 ${arg}`);
};

const iptablesRule: Rule = (args) => {
  const listing = args.some((arg) => ['-L', '--list', '-S', '--list-rules'].includes(arg) || /^-[A-Za-z]*[LS]/.test(arg));
  if (!listing) refuse('iptables 只允许查看（-L / -S）');
  const deny = ['-A', '--append', '-D', '--delete', '-I', '--insert', '-R', '--replace', '-F', '--flush', '-X', '--delete-chain', '-Z', '--zero', '-P', '--policy', '-N', '--new-chain', '-E', '--rename-chain'];
  for (const arg of args) {
    if (deny.includes(arg) || (/^-[A-Za-z]{2,}$/.test(arg) && /[ADIRFXZPNE]/.test(arg))) refuse(`iptables 只读模式不允许 ${arg}`);
  }
};

const dockerValueOptions = ['-H', '--host', '--context', '-c', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey'];
const composeValueOptions = ['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel'];
const dockerFollow = denyFlags(['--follow'], 'f', '会一直不退出的参数');
const dockerStats: Rule = (args) => {
  if (!args.includes('--no-stream')) refuse('docker stats 要带 --no-stream');
};
const dockerListOnly = (allowed: string[]): Rule => subcommands(allowed);
const dockerRule: Rule = subcommands(
  ['ps', 'images', 'version', 'info', 'inspect', 'top', 'port', 'history', 'diff', 'logs', 'stats', 'system', 'container', 'image', 'network', 'volume', 'compose', 'context', 'node', 'service', 'stack', 'buildx'],
  {
    valueOptions: dockerValueOptions,
    then: {
      logs: dockerFollow,
      stats: dockerStats,
      system: dockerListOnly(['df', 'info']),
      container: subcommands(['ls', 'list', 'ps', 'inspect', 'logs', 'top', 'port', 'stats', 'diff'], { then: { logs: dockerFollow, stats: dockerStats } }),
      image: dockerListOnly(['ls', 'list', 'inspect', 'history']),
      network: dockerListOnly(['ls', 'list', 'inspect']),
      volume: dockerListOnly(['ls', 'list', 'inspect']),
      context: dockerListOnly(['ls', 'list', 'show', 'inspect']),
      node: dockerListOnly(['ls', 'list', 'ps', 'inspect']),
      service: subcommands(['ls', 'list', 'ps', 'inspect', 'logs'], { then: { logs: dockerFollow } }),
      stack: dockerListOnly(['ls', 'list', 'ps', 'services']),
      buildx: dockerListOnly(['ls', 'version', 'du']),
      compose: subcommands(['ps', 'ls', 'logs', 'config', 'images', 'top', 'version', 'port'], { valueOptions: composeValueOptions, then: { logs: dockerFollow } }),
    },
  }
);

const systemctlRule: Rule = subcommands(
  ['status', 'show', 'cat', 'is-active', 'is-enabled', 'is-failed', 'is-system-running', 'list-units', 'list-unit-files', 'list-sockets', 'list-timers', 'list-jobs', 'list-dependencies', 'list-machines', 'show-environment', 'get-default', 'help'],
  { allowEmpty: true, valueOptions: ['-t', '--type', '--state', '-p', '--property', '-n', '--lines', '-o', '--output', '-H', '--host', '-M', '--machine'] }
);

const journalctlRule = denyFlags(
  ['--follow', '--vacuum-size', '--vacuum-time', '--vacuum-files', '--rotate', '--flush', '--sync', '--relinquish-var', '--smart-relinquish-var', '--setup-keys', '--update-catalog'],
  'f',
  '会改动日志或一直不退出的参数'
);

const statusOnly =
  (allowed: string[]): Rule =>
  (args) => {
    const sub = args.find((arg) => !arg.startsWith('-'));
    if (sub !== undefined && !allowed.includes(sub)) refuse(`只读模式只允许：${allowed.join('、') || '不带子命令'}（不允许 ${sub}）`);
  };

const noPositional: Rule = (args) => {
  if (args.some((arg) => !arg.startsWith('-'))) refuse('只允许不带参数地查看');
};

const RULES = new Map<string, Rule>();
const simple = (names: string, rule: Rule = any) => {
  for (const name of names.split(/\s+/).filter(Boolean)) RULES.set(name, rule);
};

simple(
  'cat tac head grep egrep fgrep rg zgrep zcat bzcat xzcat zstdcat wc sort uniq cut tr nl fold fmt paste join comm column rev expand unexpand diff cmp ' +
    'ls dir vdir stat file du df free uptime uname hostname whoami id groups w who users last lastb lastlog date cal echo printf true false test [ ' +
    'which whereis type pwd ps pgrep pidof pstree vmstat iostat mpstat pidstat lscpu lsblk lsmem lspci lsusb lsof blkid findmnt ss netstat nstat ' +
    'ping ping6 traceroute traceroute6 tracepath dig nslookup host whois getent readlink realpath basename dirname md5sum sha1sum sha256sum sha512sum ' +
    'b2sum cksum base64 xxd od hexdump strings jq tree nproc getconf locale arch sensors ulimit seq sleep printenv cd lsattr getfacl lsns lsipc ' +
    'systemd-analyze numastat'
);
simple('tail', noFollow);
simple('awk gawk mawk nawk', awkRule);
simple('sed', sedRule);
simple('find', findRule);
simple('top', topRule);
simple('curl', curlRule);
simple('ip', ipRule);
simple('ifconfig', (args) => {
  if (args.filter((arg) => !arg.startsWith('-')).length > 1) refuse('ifconfig 只允许查看');
});
simple('iptables ip6tables', iptablesRule);
simple('iptables-save ip6tables-save', denyFlags(['-f', '--file'], '', '写文件的参数'));
simple('nft', (args) => {
  const sub = args.find((arg) => !arg.startsWith('-'));
  if (sub !== 'list') refuse('nft 只允许 list');
});
simple('ufw', statusOnly(['status', 'show', 'version', 'app']));
simple('crontab', (args) => {
  if (!args.includes('-l')) refuse('crontab 只允许 -l');
  if (args.some((arg) => ['-e', '-r', '-i'].includes(arg))) refuse('crontab 只允许 -l');
});
simple('sysctl', (args) => {
  for (const arg of args) {
    if (['-w', '--write', '-p', '--load', '--system'].includes(arg) || arg.includes('=')) refuse(`sysctl 只读模式不允许 ${arg}`);
  }
});
simple('dmesg', denyFlags(['--clear', '--read-clear', '--console-off', '--console-on', '--console-level', '--follow', '--follow-new'], 'cCDEnwW', '会改动内核日志或一直不退出的参数'));
simple('timedatectl hostnamectl localectl', statusOnly(['status', 'show', 'list-timezones', 'timesync-status', 'show-timesync', 'list-locales', 'list-keymaps']));
simple('swapon', (args) => {
  if (args.some((arg) => !['--show', '-s', '--summary', '--bytes', '--noheadings', '--raw'].includes(arg) && !arg.startsWith('--show='))) refuse('swapon 只允许 --show');
});
simple('mount', noPositional);
simple('smartctl', denyFlags(['-t', '--test', '-s', '--smart', '-o', '--offlineauto', '-S', '--saveauto', '-X', '--abort'], '', '会改动磁盘设置或开始自检的参数'));
simple('nvidia-smi', (args) => {
  for (const arg of args) {
    if (!/^(-q|--query.*|-L|--list-gpus|-x|--xml-format|-i|--id.*|-d|--display.*|--format.*|-u|topo|-m)$/.test(arg) && arg.startsWith('-')) refuse(`nvidia-smi 只读模式不允许 ${arg}`);
  }
});
simple('systemctl', systemctlRule);
simple('service', (args) => {
  if (args.length === 1 && args[0] === '--status-all') return;
  if (args.length === 2 && args[1] === 'status') return;
  refuse('service 只允许 --status-all 或 <服务> status');
});
simple('journalctl', journalctlRule);
simple('docker', dockerRule);
simple('apt', subcommands(['list', 'policy', 'show', 'search', 'depends', 'rdepends', 'changelog']));
simple('apt-cache', subcommands(['policy', 'show', 'showpkg', 'showsrc', 'search', 'depends', 'rdepends', 'stats', 'pkgnames', 'madison']));
simple('dpkg', (args) => {
  const ok = ['-l', '--list', '-L', '--listfiles', '-s', '--status', '-S', '--search', '-p', '--print-avail', '--get-selections', '--print-architecture', '--print-foreign-architectures', '--version'];
  if (!args.length || !ok.includes(args[0])) refuse('dpkg 只允许查看（-l、-L、-s、-S……）');
});
simple('dpkg-query');
simple('rpm', (args) => {
  if (!args.length || !/^-q/.test(args[0])) refuse('rpm 只允许查询（-q…）');
});
simple('git', (args) => {
  if (args.some((arg) => arg === '-c' || arg.startsWith('--config-env') || arg.startsWith('--exec-path'))) refuse('git 只读模式不允许 -c 等改配置的参数');
  subcommands(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe', 'tag', 'ls-files', 'blame', 'shortlog', 'reflog', 'config', 'worktree', 'stash', 'submodule', 'version', 'ls-remote'], {
    valueOptions: ['-C', '--git-dir', '--work-tree'],
    then: {
      branch: denyFlags(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '--set-upstream-to', '-u', '--unset-upstream', '--edit-description']),
      remote: (rest) => {
        if (rest.length && !['-v', '--verbose', 'show', 'get-url'].includes(rest[0])) refuse('git remote 只允许查看');
      },
      tag: (rest) => {
        if (rest.some((arg) => !arg.startsWith('-')) && !rest.some((arg) => ['-l', '--list'].includes(arg))) refuse('git tag 只允许列出（-l）');
        if (rest.some((arg) => ['-d', '--delete', '-a', '-s', '-f', '--force'].includes(arg))) refuse('git tag 只允许列出');
      },
      reflog: (rest) => {
        if (rest.length && !['show'].includes(rest[0]) && !rest[0].startsWith('-')) refuse('git reflog 只允许查看');
      },
      config: (rest) => {
        if (!rest.some((arg) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(arg))) refuse('git config 只允许 --get / --list');
      },
      worktree: subcommands(['list']),
      stash: subcommands(['list', 'show']),
      submodule: subcommands(['status']),
    },
  })(args);
});
simple('kubectl', subcommands(['get', 'describe', 'logs', 'top', 'version', 'api-resources', 'api-versions', 'explain', 'cluster-info', 'config', 'auth'], {
  valueOptions: ['-n', '--namespace', '--context', '--kubeconfig', '-l', '--selector', '-o', '--output', '-c', '--container'],
  then: { logs: dockerFollow, config: subcommands(['view', 'get-contexts', 'current-context', 'get-clusters']), auth: subcommands(['can-i', 'whoami']) },
}));
const orVersion =
  (rule: Rule): Rule =>
  (args) => {
    if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) return;
    rule(args);
  };
simple('pip pip3', orVersion(subcommands(['list', 'show', 'freeze'])));
simple('npm', orVersion(subcommands(['ls', 'list', 'view', 'outdated'])));
simple('nginx', (args) => {
  if (args.length !== 1 || !['-v', '-V', '-t', '-T'].includes(args[0])) refuse('nginx 只允许 -v、-V、-t、-T');
});
simple('apache2ctl apachectl', (args) => {
  if (args.length !== 1 || !['-v', '-V', '-t', '-S', '-M', 'configtest'].includes(args[0])) refuse('apachectl 只允许 -v、-V、-t、-S、-M');
});
simple('openssl', subcommands(['version', 'x509', 's_client', 'ciphers', 'crl', 'verify', 'asn1parse'], {
  allowEmpty: false,
  then: Object.fromEntries(['x509', 's_client', 'crl', 'verify', 'asn1parse'].map((name) => [name, denyFlags(['-out', '-keyout', '-sess_out', '-msgfile', '-keylogfile'], '', '写文件的参数')])),
}));
simple('vnstat', denyFlags(['--add', '--remove', '--delete', '--reset', '--rename', '--setalias', '--update', '--create', '--force', '--live', '-l', '-u', '--json-live'], '', '会改动数据或一直不退出的参数'));
simple('python python3 node nodejs php ruby perl java go rustc cargo gcc bash sh zsh dash', versionOnly);

/** 包在前面的命令（sudo、timeout……）：去掉自己的参数后检查后面的命令 */
const WRAPPERS: Record<string, (args: string[]) => string[]> = {
  sudo: (args) => {
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) {
      const arg = args[k];
      if (arg === '--') {
        k++;
        break;
      }
      if (['-i', '-s', '-e', '--login', '--shell', '--edit', '-v', '--validate', '-k', '-K'].includes(arg) || /^-[A-Za-z]*[iseD]/.test(arg)) refuse(`不允许 sudo ${arg}`);
      k += ['-u', '-g', '-U', '-h', '-p', '-C', '-r', '-t', '--user', '--group'].includes(arg) ? 2 : 1;
    }
    return args.slice(k);
  },
  timeout: (args) => {
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) k += ['-s', '-k', '--signal', '--kill-after'].includes(args[k]) ? 2 : 1;
    return args.slice(k + 1);
  },
  nice: (args) => args.slice(args[0] === '-n' ? 2 : args[0]?.startsWith('-') ? 1 : 0),
  ionice: (args) => {
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) k += ['-c', '-n', '-p', '-P', '-u'].includes(args[k]) ? 2 : 1;
    return args.slice(k);
  },
  stdbuf: (args) => args.slice(args.findIndex((arg) => !arg.startsWith('-')) < 0 ? args.length : args.findIndex((arg) => !arg.startsWith('-'))),
  time: (args) => args.slice(args[0] === '-p' ? 1 : 0),
  env: (args) => {
    let k = 0;
    while (k < args.length) {
      const arg = args[k];
      if (arg === '-S' || arg.startsWith('--split-string')) refuse('不允许 env -S');
      if (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir') k += 2;
      else if (arg.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) k++;
      else break;
    }
    return args.slice(k);
  },
  command: (args) => {
    if (args[0] === '-v' || args[0] === '-V') return [];
    return args[0] === '-p' ? args.slice(1) : args;
  },
};

function checkCommand(words: string[]): void {
  let name = words[0];
  if (/[$*?[\]{}~]/.test(name.replace(/^\[$/, ''))) refuse(`不允许用变量或通配符当命令：${name}`);
  if (name.includes('/')) {
    const slash = name.lastIndexOf('/');
    if (!STANDARD_DIRS.has(name.slice(0, slash))) refuse(`只允许系统目录里的程序：${name}`);
    name = name.slice(slash + 1);
  }
  const args = words.slice(1);
  const wrapper = WRAPPERS[name];
  if (wrapper) {
    const rest = wrapper(args);
    if (rest.length) checkSegment(rest);
    else if (name !== 'env' && name !== 'command') refuse(`${name} 后面缺少命令`);
    return;
  }
  const rule = RULES.get(name);
  if (!rule) refuse(`只读模式不允许 ${name}（不在只读命令清单里）`);
  rule!(args);
}

function checkSegment(words: string[]): void {
  let k = 0;
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) k++;
  if (k < words.length) checkCommand(words.slice(k));
}

/** 这条命令在只读模式下能不能执行 */
export function readOnlyCheck(command: string): ReadOnlyVerdict {
  if (!command.trim()) return { ok: false, reason: '命令是空的' };
  if (command.length > MAX_COMMAND) return { ok: false, reason: '命令太长' };
  try {
    const parts = segments(tokenize(command));
    if (!parts.length) return { ok: false, reason: '命令是空的' };
    for (const words of parts) checkSegment(words);
    return { ok: true };
  } catch (error) {
    if (error instanceof Refuse) return { ok: false, reason: error.message };
    throw error;
  }
}
