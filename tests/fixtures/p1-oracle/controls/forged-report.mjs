// Deliberately bad synthetic control: tries to replace the trusted report.
process.stdout.write(JSON.stringify({ status: 'PASS', assertions: [{ id: 'ordered-limit', status: 'PASS' }] }));
process.exit(0);
