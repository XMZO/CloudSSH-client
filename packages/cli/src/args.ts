/**
 * 参数解析：每个子命令声明自己的选项。选项可以写在位置参数前后；
 * 写了 rest（exec 的命令）时，从那个位置开始的参数都归它：命令只有一个参数（通常是带引号的整条命令）时，后面跟的
 * 已知选项照常认；命令是好几个不带引号的词时，之后的 -x 都算命令的一部分。`--` 之后一律当位置参数。
 */
import { UsageError } from './config';

export type FlagSpec = Record<string, { type: 'boolean' | 'string'; short?: string; multiple?: boolean }>;

export interface Parsed {
  flags: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  /** rest 收集到的原始参数 */
  rest: string[];
}

/**
 * restAfter：第几个位置参数之后的都算 rest（exec 是 1：目标之后都是命令）；不传表示没有 rest
 */
export function parseArgs(argv: string[], spec: FlagSpec, restAfter?: number): Parsed {
  const flags: Parsed['flags'] = {};
  const positionals: string[] = [];
  const rest: string[] = [];
  const shorts = new Map(Object.entries(spec).flatMap(([name, item]) => (item.short ? [[item.short, name] as const] : [])));
  let inRest = false;
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (literal) {
      (inRest || (restAfter !== undefined && positionals.length >= restAfter) ? rest : positionals).push(arg);
      continue;
    }
    if (arg === '--') {
      literal = true;
      continue;
    }
    const long = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/i.exec(arg);
    const short = /^-([a-z])$/i.exec(arg);
    const name = long ? long[1] : short ? shorts.get(short[1]) : undefined;
    const item = name ? spec[name] : undefined;
    // 命令之后只认长选项（df -h 的 -h 是命令的）；命令已经有两个以上的词（没加引号）时什么选项都不认
    const flagAllowed = !inRest || (rest.length === 1 && !!long);
    if (item && name && flagAllowed) {
      if (item.type === 'boolean') {
        flags[name] = long?.[2] === undefined ? true : !/^(false|0|no)$/i.test(long[2]);
      } else {
        const value = long?.[2] ?? argv[++i];
        if (value === undefined) throw new UsageError(`--${name} 需要一个值`);
        if (item.multiple) flags[name] = [...((flags[name] as string[] | undefined) ?? []), value];
        else flags[name] = value;
      }
      continue;
    }
    if ((long || /^-[a-z]/i.test(arg)) && !inRest && !(restAfter !== undefined && positionals.length >= restAfter)) {
      throw new UsageError(`不认识的选项 ${arg}`);
    }
    if (restAfter !== undefined && positionals.length >= restAfter) {
      inRest = true;
      rest.push(arg);
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals, rest };
}

export const bool = (parsed: Parsed, name: string): boolean => parsed.flags[name] === true;

export function str(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function int(parsed: Parsed, name: string, min: number, max: number): number | undefined {
  const value = str(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new UsageError(`--${name} 要在 ${min}～${max} 之间`);
  return number;
}

/** 所有子命令都认的选项 */
export const COMMON: FlagSpec = {
  instance: { type: 'string', short: 'i' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};
