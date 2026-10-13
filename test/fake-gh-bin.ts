// Executable fake `gh` for subprocess tests (see installFakeGh). State is the JSON file named by
// PRR_FAKE_GH_STATE; failures go to stderr with exit 1, like the real gh.
// When PRR_FAKE_GH_TOKEN is set (CI mode), GH_TOKEN must equal it, as gh has no other login there, and GH_REPO
// must be set. GH_REPO, when set, must name the fake's repository. Values are compared, never printed.
import { readFileSync, writeFileSync } from 'node:fs';
import { FakeGitHub, type FakeState } from './fake-gh.ts';

const statePath = process.env.PRR_FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write('fake gh: PRR_FAKE_GH_STATE is not set\n');
  process.exit(1);
}
const fake = new FakeGitHub(JSON.parse(readFileSync(statePath, 'utf8')) as FakeState);
const expectedToken = process.env.PRR_FAKE_GH_TOKEN;
if (expectedToken !== undefined && process.env.GH_TOKEN !== expectedToken) {
  process.stderr.write('gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n');
  process.exit(4);
}
const ghRepo = process.env.GH_REPO;
if (ghRepo === undefined && expectedToken !== undefined) {
  // CI mode: the Action's workspace may have no git remote, so the repository must come from GH_REPO.
  process.stderr.write('failed to determine base repo: set GH_REPO to OWNER/REPO (no git remote to infer the repository from)\n');
  process.exit(1);
}
if (ghRepo !== undefined && ghRepo !== `${fake.state.owner}/${fake.state.repo}`) {
  process.stderr.write(`GraphQL: Could not resolve to a Repository with the name '${ghRepo}'.\n`);
  process.exit(1);
}
const stdin = readFileSync(0, 'utf8');
try {
  process.stdout.write(fake.handle(process.argv.slice(2), stdin === '' ? undefined : stdin));
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exitCode = 1;
} finally {
  writeFileSync(statePath, JSON.stringify(fake.state));
}
