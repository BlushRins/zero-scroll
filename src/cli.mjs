#!/usr/bin/env node
import { runMorningBriefing } from './briefing.mjs';
import { addBrainDump, listInbox, updateInboxItem } from './inbox.mjs';
import { listReadLater, runReadLaterDigest, saveReadLater } from './readlater.mjs';
import { runReminders } from './reminders.mjs';
import { startServer } from './server.mjs';

function printHelp() {
  console.log(`ZeroScroll CLI

Usage:
  zero-scroll brief [--dry-run]          Build and deliver the Morning Briefing
  zero-scroll reminders [--dry-run]      Check Brain Dump due dates and send alerts
  zero-scroll digest [--dry-run]         Summarize and deliver unread Read-Later links
  zero-scroll dump "<text>"              Parse and store a Brain Dump capture (URLs auto-route to Read-Later)
  zero-scroll save "<url>" [note]        Save and summarize a Read-Later link
  zero-scroll list [inbox|readlater]     List stored captures
  zero-scroll done <id>                  Mark an inbox item complete
  zero-scroll dev [--port 4310]          Start the local web dashboard
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dryRun = args.includes('--dry-run');

  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp();
    return;
  }

  if (cmd === 'brief') {
    const res = await runMorningBriefing({ dryRun });
    if (dryRun) {
      console.log(res.text);
      console.log('\n--- Delivery (dry-run) ---');
    }
    console.log(JSON.stringify(res.delivery, null, 2));
    if (res.briefing.warnings.length > 0) {
      console.error('Warnings:', res.briefing.warnings.join(' | '));
    }
    return;
  }

  if (cmd === 'reminders') {
    const res = await runReminders({ dryRun });
    console.log(`Triggered reminders: ${res.triggered.length}`);
    if (dryRun && res.text) console.log(res.text);
    console.log(JSON.stringify(res.delivery, null, 2));
    return;
  }

  if (cmd === 'digest') {
    const res = await runReadLaterDigest({ dryRun });
    console.log(`Read-Later items: ${res.items.length}`);
    if (dryRun && res.text) console.log(res.text);
    console.log(JSON.stringify(res.delivery, null, 2));
    return;
  }

  if (cmd === 'dump') {
    const text = args.slice(1).join(' ').trim();
    if (!text) {
      console.error('Provide capture text, for example: zero-scroll dump "submit lab friday 5pm #school"');
      process.exitCode = 1;
      return;
    }
    const result = await addBrainDump(text);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'save') {
    const url = args[1];
    const note = args.slice(2).join(' ').trim();
    if (!url) {
      console.error('Provide a URL, for example: zero-scroll save "https://openai.com/news/"');
      process.exitCode = 1;
      return;
    }
    const saved = await saveReadLater(url, { note });
    console.log(JSON.stringify(saved, null, 2));
    return;
  }

  if (cmd === 'list') {
    const target = args[1] || 'inbox';
    if (target === 'readlater') {
      console.log(JSON.stringify(listReadLater(), null, 2));
    } else {
      console.log(JSON.stringify(listInbox(), null, 2));
    }
    return;
  }

  if (cmd === 'done') {
    const id = args[1];
    if (!id) {
      console.error('Provide an item id.');
      process.exitCode = 1;
      return;
    }
    const updated = updateInboxItem(id, { done: true });
    if (!updated) {
      console.error(`Item not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(updated, null, 2));
    return;
  }

  if (cmd === 'dev') {
    const portIdx = args.indexOf('--port');
    const port = portIdx !== -1 ? Number(args[portIdx + 1]) || 4310 : Number(process.env.PORT) || 4310;
    await startServer({ port });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
