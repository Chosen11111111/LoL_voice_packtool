/** 进程入口: 转发到 CLI。 */
import { runCli } from "./cli.ts";

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
