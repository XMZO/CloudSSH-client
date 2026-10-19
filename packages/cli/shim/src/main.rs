//! cloudssh 的 Windows 启动器（装成 cloudssh.exe、cssh.exe）。
//!
//! 为什么不用 .cmd：PowerShell 调批处理文件时按旧规则拼命令行，参数里的双引号不转义，再经 cmd 的 %* 转给
//! Node，`'echo "a b"'` 会被拆成两个参数，后面的 --json 也跟着算进远程命令。调 .exe 时 PowerShell 7.3 起
//! 按标准规则转义，cmd 也只解析一次，所以换成这个小程序。
//!
//! 做的事：读与自己同名的 .shim（cloudssh.exe → cloudssh.shim），按里面的 runtime、program、env 启动
//! `"runtime" "program" <原样的其余命令行>`。其余命令行直接取 GetCommandLineW 去掉第一段，不重新拆分、
//! 不重新转义，Node 收到的与直接调它时一模一样。
//!
//! - 退出码原样返回；标准输入输出直接继承
//! - Ctrl+C 交给子进程处理，自己不退出（不能用 SetConsoleCtrlHandler(NULL, TRUE)：那会被子进程继承）
//! - 子进程放进“关闭即结束”的作业对象：调用方杀掉启动器（AI 工具超时）时 Node 跟着结束；允许它的子进程
//!   脱离作业（uninstall 退出后再删文件的那个 cmd 要活下来）
//! - 设 CLOUDSSH_SHIM=exe，命令行据此知道自己是经启动器运行的
//! - 由 PowerShell 启动、而命令行里有“词中间的引号”时拒绝运行：Windows PowerShell 5.1（以及 7.3 之前的
//!   pwsh、或 $PSNativeCommandArgumentPassing 设成 Legacy）调任何程序都不转义参数里的双引号，
//!   `'grep "a b" f'` 到这里已经变成 `"grep "a b" f"`，Node 会拆成 `grep a`、`b f`。远程执行拆坏的命令
//!   可能出事，所以不运行，提示改用 pwsh 或 --stdin。正常转义（7.3 起、Node、Git Bash）只会在词首词尾出现
//!   引号，词中间的引号写成 \"，不会误判
//!
//! .shim 的格式（UTF-8，# 开头是注释；cloudssh install 写，见 packages/cli/src/install.ts）：
//!
//! ```text
//! # cloudssh-shim 0.3.26
//! runtime=C:\Program Files\nodejs\node.exe
//! program=C:\Users\me\AppData\Local\cloudssh-cli\cloudssh.mjs
//! env=ELECTRON_RUN_AS_NODE=1
//! ```

use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{exit, Command};

/// 卸载与状态检查靠这个标记认出是我们装的（install.ts 的 MARK）
#[used]
static MARKER: [u8; 22] = *b"cloudssh-shim launcher";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: u32 = 0x1000;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

#[repr(C)]
#[derive(Default)]
struct JobBasicLimits {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct JobExtendedLimits {
    basic: JobBasicLimits,
    io_counters: [u64; 6],
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

const TH32CS_SNAPPROCESS: u32 = 0x2;

#[repr(C)]
struct ProcessEntry {
    size: u32,
    usage: u32,
    process_id: u32,
    default_heap_id: usize,
    module_id: u32,
    threads: u32,
    parent_process_id: u32,
    priority_class_base: i32,
    flags: u32,
    exe_file: [u16; 260],
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcessId() -> u32;
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
    fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn GetCommandLineW() -> *const u16;
    fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, length: u32) -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
}

/// 控制台事件都算“处理过了”：Ctrl+C 由子进程自己处理，启动器等它退出
unsafe extern "system" fn ignore_console_event(_event: u32) -> i32 {
    1
}

fn fail(message: &str) -> ! {
    eprintln!("cloudssh: {message}");
    exit(1);
}

/// 原始命令行去掉第一段（程序名）后的部分。第一段按 C 运行时的规则：以引号开头就到下一个引号，否则到空白
fn arguments_tail() -> String {
    let line: Vec<u16> = unsafe {
        let start = GetCommandLineW();
        let mut length = 0;
        while *start.add(length) != 0 {
            length += 1;
        }
        std::slice::from_raw_parts(start, length).to_vec()
    };
    let quote = u16::from(b'"');
    let blank = |c: u16| c == u16::from(b' ') || c == u16::from(b'\t');
    let mut index = 0;
    if line.first() == Some(&quote) {
        index = 1;
        while index < line.len() && line[index] != quote {
            index += 1;
        }
        index = (index + 1).min(line.len());
    } else {
        while index < line.len() && !blank(line[index]) {
            index += 1;
        }
    }
    while index < line.len() && blank(line[index]) {
        index += 1;
    }
    String::from_utf16_lossy(&line[index..])
}

/// 有没有“词中间的引号”：按 C 运行时的规则分词，前面是奇数个反斜杠的引号是字面引号，不算；
/// 其余引号出现在词首或词尾以外的位置就算
fn has_mid_word_quote(tail: &str) -> bool {
    let chars: Vec<char> = tail.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        while index < chars.len() && (chars[index] == ' ' || chars[index] == '\t') {
            index += 1;
        }
        let start = index;
        let mut quoted = false;
        let mut backslashes = 0;
        let mut toggles = Vec::new();
        while index < chars.len() && (quoted || (chars[index] != ' ' && chars[index] != '\t')) {
            match chars[index] {
                '\\' => backslashes += 1,
                '"' => {
                    if backslashes % 2 == 0 {
                        quoted = !quoted;
                        toggles.push(index);
                    }
                    backslashes = 0;
                }
                _ => backslashes = 0,
            }
            index += 1;
        }
        let end = index;
        if toggles.iter().any(|&at| at != start && at + 1 != end) {
            return true;
        }
    }
    false
}

/// 父进程的程序名（小写），取不到就是空的
fn parent_name() -> String {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() || snapshot as isize == -1 {
            return String::new();
        }
        let mut entries = Vec::new();
        let mut entry: ProcessEntry = std::mem::zeroed();
        entry.size = std::mem::size_of::<ProcessEntry>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let length = entry.exe_file.iter().position(|&c| c == 0).unwrap_or(entry.exe_file.len());
                entries.push((entry.process_id, entry.parent_process_id, String::from_utf16_lossy(&entry.exe_file[..length])));
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        let me = GetCurrentProcessId();
        let Some(&(_, parent, _)) = entries.iter().find(|(id, _, _)| *id == me) else { return String::new() };
        entries
            .iter()
            .find(|(id, _, _)| *id == parent)
            .map(|(_, _, name)| name.to_lowercase())
            .unwrap_or_default()
    }
}

/// PowerShell 按旧规则拆坏了带引号的参数时，不运行
fn refuse_mangled_quotes(tail: &str) {
    if !tail.contains('"') || !has_mid_word_quote(tail) {
        return;
    }
    let parent = parent_name();
    let shell = match parent.as_str() {
        "powershell.exe" => "Windows PowerShell 5.1",
        "pwsh.exe" => "这个 PowerShell（7.3 之前的版本，或 $PSNativeCommandArgumentPassing 是 Legacy）",
        _ => return,
    };
    eprintln!(
        "cloudssh: 参数里的双引号被 {shell} 拆掉了，收到的命令和写的不一样，为安全起见没有执行。\n\
         请改用 PowerShell 7.3 以上（pwsh），或把命令经 --stdin 传入：\n\
         @'\n<命令>\n'@ | cloudssh exec --stdin <目标>"
    );
    exit(2);
}

struct Shim {
    runtime: String,
    program: String,
    env: Vec<(String, String)>,
}

fn read_shim(path: &PathBuf) -> Shim {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|error| fail(&format!("读不到启动配置 {}：{error}。请重新运行 cloudssh install", path.display())));
    let mut runtime = None;
    let mut program = None;
    let mut env = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        match key.trim() {
            "runtime" => runtime = Some(value.trim().to_string()),
            "program" => program = Some(value.trim().to_string()),
            "env" => {
                if let Some((name, value)) = value.split_once('=') {
                    env.push((name.trim().to_string(), value.to_string()));
                }
            }
            _ => {}
        }
    }
    match (runtime, program) {
        (Some(runtime), Some(program)) if !runtime.is_empty() && !program.is_empty() => Shim { runtime, program, env },
        _ => fail(&format!("启动配置 {} 不完整，请重新运行 cloudssh install", path.display())),
    }
}

/// 子进程放进关闭即结束的作业；失败（比如外层作业不允许）就算了，只是少了“随启动器一起结束”
fn kill_with_launcher(process: *mut c_void) {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut limits = JobExtendedLimits::default();
        limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        let size = std::mem::size_of::<JobExtendedLimits>() as u32;
        if SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, &limits as *const _ as *const c_void, size) != 0 {
            AssignProcessToJobObject(job, process);
        }
        // 作业句柄故意不关：启动器退出（或被杀）时系统关掉它，作业里的进程随之结束
    }
}

fn main() {
    // 引用一下标记，免得链接器把它当没用的数据删掉
    std::hint::black_box(MARKER.as_ptr());
    let exe = std::env::current_exe().unwrap_or_else(|error| fail(&format!("找不到启动器自己的位置：{error}")));
    let shim = read_shim(&exe.with_extension("shim"));
    if !std::path::Path::new(&shim.runtime).exists() {
        fail(&format!("运行时 {} 不在了（Node 或 CloudSSH 客户端换了位置？）。请重新运行 cloudssh install", shim.runtime));
    }
    if !std::path::Path::new(&shim.program).exists() {
        fail(&format!("程序 {} 不在了。请重新运行 cloudssh install", shim.program));
    }

    let tail = arguments_tail();
    refuse_mangled_quotes(&tail);
    let mut command = Command::new(&shim.runtime);
    command.arg(&shim.program);
    if !tail.is_empty() {
        command.raw_arg(&tail);
    }
    command.env("CLOUDSSH_SHIM", "exe");
    for (name, value) in &shim.env {
        command.env(name, value);
    }

    unsafe {
        SetConsoleCtrlHandler(Some(ignore_console_event), 1);
    }
    let mut child = command
        .spawn()
        .unwrap_or_else(|error| fail(&format!("启动 {} 失败：{error}", shim.runtime)));
    kill_with_launcher(child.as_raw_handle() as *mut c_void);
    let status = child.wait().unwrap_or_else(|error| fail(&format!("等待 {} 结束失败：{error}", shim.runtime)));
    exit(status.code().unwrap_or(1));
}

#[cfg(test)]
mod tests {
    use super::has_mid_word_quote;

    #[test]
    fn standard_quoting_is_fine() {
        // PowerShell 7.3 起、Node、Git Bash 的转义：引号只在词首词尾，词中间写成 \"
        assert!(!has_mid_word_quote(r#"exec srv-1 "echo \"$(hostname) ok\"" --json"#));
        assert!(!has_mid_word_quote(r#"exec srv-1 "df -h""#));
        assert!(!has_mid_word_quote(r#""C:\dir with space\\" "" a\"b"#));
        assert!(!has_mid_word_quote("servers -q web --json"));
    }

    #[test]
    fn legacy_powershell_quoting_is_detected() {
        // Windows PowerShell 5.1 把 'echo "$(hostname) ok"' 原样包一层引号
        assert!(has_mid_word_quote(r#"exec srv-1 "echo "$(hostname) ok"" --json"#));
        assert!(has_mid_word_quote(r#"exec srv-1 a"b"#));
    }
}
