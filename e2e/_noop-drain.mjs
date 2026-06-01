#!/usr/bin/env node
// No-op stand-in for synth-drain.js, used only by the hooks smoke. Pointing
// HIVE_MIND_DRAIN_SCRIPT at this guarantees session-start's opportunistic
// catch-up cannot spawn a real drain against the user's ~/.hive-mind during a test.
process.exit(0);
