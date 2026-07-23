export const DEV_USAGE = `Usage: authorbot dev [path] [options]
       authorbot dev status [path] [--json]
       authorbot dev agent-env [path]
       authorbot dev reset [path] --yes
       authorbot dev pr [path]
       authorbot dev clean [path]

Start a loopback-only local authoring site backed by a managed Git worktree.

Options:
  --port <port>                 browser port (default 4321)
  --open                        open the site in the default browser
  --fresh                       rotate local database, sessions, and tokens
  --authorbot-source <checkout> run a different Authorbot source checkout
  --promote-book                permit PR creation for a source-dogfood sandbox
  --json                        machine-readable status output
  --yes                         confirm reset
  -h, --help                    show this help`;
