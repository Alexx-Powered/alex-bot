// Operator-only. The probe has no BridgeCore, QQ send path, database or model.
import fs from 'node:fs/promises';
import path from 'node:path';
import {OneBotAdapter,validateOneBotProfile} from '../src/onebot-adapter.mjs';

const directory = process.env.CREDENTIALS_DIRECTORY;
const config = validateOneBotProfile(JSON.parse(await fs.readFile(path.join(directory,'onebot.json'),'utf8')));
if (config.mode !== 'receive-only') throw Error('PROBE_REQUIRES_RECEIVE_ONLY');
const challenge = (await fs.readFile(path.join(directory,'probe.challenge'),'utf8')).trim();
if (!/^[a-f0-9]{16}$/.test(challenge)) throw Error('PROBE_CHALLENGE_INVALID');
const counts = {c2c:0,group:0};
const adapter = new OneBotAdapter({
  admit: event => event.text === '/probe '+challenge,
  onMessage: event => {
    counts[event.kind]++;
    console.log(JSON.stringify({matched:counts}));
  },
  onStatus: ({state,code}) => {
    console.log(JSON.stringify({state,code}));
    if (state === 'blocked') process.exitCode = 1;
  },
});
try { await adapter.connect(config); }
catch { process.exitCode = 1; }
for (const sig of ['SIGINT','SIGTERM']) process.once(sig,() => adapter.disconnect());
