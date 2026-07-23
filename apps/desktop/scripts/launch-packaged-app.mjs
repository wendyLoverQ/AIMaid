import { spawn } from 'node:child_process'

const [executable, workingDirectory, ...launchArguments] = process.argv.slice(2)

if (!executable || !workingDirectory) {
  process.stderr.write('Usage: node launch-packaged-app.mjs <executable> <working-directory> [arguments...]\n')
  process.exit(1)
}

const application = spawn(executable, launchArguments, {
  cwd: workingDirectory,
  detached: true,
  stdio: 'ignore',
  windowsHide: true
})

application.once('error', (error) => {
  process.stderr.write(`Failed to launch AIMaid: ${error.message}\n`)
  process.exitCode = 1
})

application.once('spawn', () => {
  application.unref()
  process.stdout.write(`AIMaid started independently (PID ${application.pid}).\n`)
})
