#!/usr/bin/env node
/*
 * Cross-platform wrapper for scripts/android-env.sh
 * - On macOS: applies ANDROID_SDK_ROOT, PATH (sdk tools), JAVA_HOME (JDK 17), and optional scripts/.tools/node/bin
 * - On other OS (Windows/Linux): no-op for Android env; just runs the given command
 *
 * Usage examples (in package.json scripts):
 *   "dev": "node ../scripts/run-android-env.mjs next dev"
 *   "build": "node ../scripts/run-android-env.mjs next build"
 *   "build:static": "node ../scripts/run-android-env.mjs \"next build && next export\""
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

function prependToPath(env, dir) {
  if (!dir) return
  const current = env.PATH || env.Path || ''
  const parts = current.split(path.delimiter)
  if (!parts.includes(dir)) {
    const next = [dir, ...parts].filter(Boolean).join(path.delimiter)
    env.PATH = next
    // On Windows, ensure 'Path' also reflects changes
    env.Path = next
  }
}

function applyAndroidEnvIfDarwin(env) {
  if (process.platform !== 'darwin') return

  // Ensure project-pinned Node 20 (if present) takes precedence
  const toolsNodeBin = path.join(PROJECT_ROOT, 'scripts', '.tools', 'node', 'bin')
  if (existsSync(toolsNodeBin)) prependToPath(env, toolsNodeBin)

  // ANDROID_SDK_ROOT default
  if (!env.ANDROID_SDK_ROOT) {
    env.ANDROID_SDK_ROOT = path.join(env.HOME || process.env.HOME || '', 'Library', 'Android', 'sdk')
  }

  // Prepend Android SDK tools to PATH
  const cmdlineTools = path.join(env.ANDROID_SDK_ROOT, 'cmdline-tools', 'latest', 'bin')
  const platformTools = path.join(env.ANDROID_SDK_ROOT, 'platform-tools')
  prependToPath(env, cmdlineTools)
  prependToPath(env, platformTools)

  // JAVA_HOME for JDK 17 via /usr/libexec/java_home
  try {
    const r = spawnSync('/usr/libexec/java_home', ['-v', '17'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout) {
      env.JAVA_HOME = r.stdout.trim()
    }
  } catch {
    // ignore if not available
  }
}

function runCommand(argv, env) {
  if (argv.length === 0) {
    // Interactive shell
    const shell = process.platform === 'win32'
      ? (env.ComSpec || 'C\\\Windows\\System32\\cmd.exe')
      : (env.SHELL || '/bin/bash')
    const child = spawn(shell, { stdio: 'inherit', env })
    child.on('exit', code => process.exit(code ?? 0))
    child.on('error', err => { console.error(err); process.exit(1) })
    return
  }

  if (argv.length === 1) {
    // Single string, run via shell so things like "&&" work cross-platform
    const cmdString = argv[0]
    const child = spawn(cmdString, { stdio: 'inherit', env, shell: true })
    child.on('exit', code => process.exit(code ?? 0))
    child.on('error', err => { console.error(err); process.exit(1) })
    return
  }

  // First token is command, rest are args
  const [cmd, ...args] = argv
  const child = spawn(cmd, args, { stdio: 'inherit', env })
  child.on('exit', code => process.exit(code ?? 0))
  child.on('error', err => { console.error(err); process.exit(1) })
}

const env = { ...process.env }

// Ensure project-pinned Node 20 for all platforms if present
const toolsNodeBin = path.join(PROJECT_ROOT, 'scripts', '.tools', 'node', 'bin')
if (existsSync(toolsNodeBin)) prependToPath(env, toolsNodeBin)

applyAndroidEnvIfDarwin(env)

const argv = process.argv.slice(2)
runCommand(argv, env)

