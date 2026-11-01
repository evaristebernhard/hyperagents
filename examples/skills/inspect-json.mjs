// No credentials, network or filesystem access: summarize one JSON argv value.
const args = process.argv.slice(2);
if (args.length !== 1 || Buffer.byteLength(args[0]) > 16384) {
  console.error('Expected one bounded JSON argument.');
  process.exitCode = 2;
} else {
  try {
    const value = JSON.parse(args[0]);
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const summary = { type };
    if (type === 'object') { summary.keyCount = Object.keys(value).length; summary.keys = Object.keys(value).slice(0, 50); }
    if (type === 'array') summary.length = value.length;
    console.log(JSON.stringify(summary));
  } catch {
    // Do not echo the supplied input into errors.
    console.error('Invalid JSON input.');
    process.exitCode = 2;
  }
}
