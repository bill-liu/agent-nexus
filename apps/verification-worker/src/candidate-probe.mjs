// Retired: importing candidate code into an observation process gives it stdout.
// Keep an explicit block so old A3 deployments cannot silently run this probe.
process.stderr.write('BLOCKED_PROTECTED_INVOCATION_REQUIRED\n');
process.exitCode = 70;
