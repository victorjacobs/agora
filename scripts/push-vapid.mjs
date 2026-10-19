import { writeFileSync } from 'node:fs'
import webpush from 'web-push'

const [path, subject] = process.argv.slice(2)
if (!path || !subject || !/^(mailto:|https:\/\/)/.test(subject)) throw new Error('Usage: node scripts/push-vapid.mjs /private/path/vapid.json mailto:operator@example.com')
writeFileSync(path, JSON.stringify({ ...webpush.generateVAPIDKeys(), subject }) + '\n', { mode: 0o600, flag: 'wx' })
console.info('Created VAPID secret file (0600). Keep it stable and private; never put it in the Nix store.')
