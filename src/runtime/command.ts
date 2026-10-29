/** Common process conventions for independently executable applications. */

import { VERSION } from "../version.ts";

export const help = (text: string): number => {
  process.stdout.write(`${text}\n`);
  return 0;
};

export async function run(
  program: string,
  args: string[],
  command: (args: string[]) => Promise<number>,
): Promise<number> {
  try {
    return args[0] === "--version" ? help(VERSION) : await command(args);
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    process.stderr.write(`${program}: ${code ? `${code}: ` : ""}${message}\n`);
    return 1;
  }
}
