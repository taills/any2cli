import { run } from './cli/program.js';

const code = await run(process.argv.slice(2));
await new Promise((resolve) => process.stdout.write('', resolve));
await new Promise((resolve) => process.stderr.write('', resolve));
process.exit(code);
