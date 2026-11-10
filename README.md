# soroban-verify-action

Rebuilds a Soroban contract at a commit with the `soroban-verify` CLI (repository `soroban-verify-cli`),
compares the WASM hash to the deployed contract (testnet), and **fails the check on a mismatch**.

- **Pull requests:** posts one PR comment with both hashes, updated in place on re-runs.
- **Every run:** uploads the JSON result as the `soroban-verify-hash` artifact.
- **Releases:** adds a block with the WASM hash to the release notes, replaced (not duplicated) on re-runs.
- **Registry (optional):** with `registry-url` set, posts **verified** results to a
  `soroban-verify-registry`. A registry failure only warns.

Runs on the `node24` runtime. Runs without a pull request (release, push, manual dispatch) skip the
comment and do everything else.

## Example workflow

```yaml
name: verify
on:
  pull_request:
  release:
    types: [published]
permissions:
  contents: write        # edit release notes
  pull-requests: write   # comment on the PR
jobs:
  verify:
    runs-on: ubuntu-latest   # docker, git and the Rust toolchain are preinstalled
    steps:
      - name: Install stellar CLI and soroban-verify
        run: |
          cargo install --locked stellar-cli
          cargo install --locked --git https://github.com/Samebytes/soroban-verify-cli
      - uses: Samebytes/soroban-verify-action@v0
        with:
          contract-id: CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
          # registry-url: https://registry.example.com
          # registry-api-key: ${{ secrets.REGISTRY_API_KEY }}
```

Replace the contract ID with your own. Pin `@v0` to a release tag or commit SHA for reproducible runs.
This workflow has not yet been run on a GitHub-hosted runner.

## Inputs

| Input | Required | Default |
|---|---|---|
| `contract-id` | yes | |
| `repo` | no | the current repository |
| `commit` | no | the triggering SHA |
| `image` | no | chosen by the CLI from the repo's `soroban-sdk` version |
| `registry-url` | no | none: nothing is posted |
| `registry-api-key` | no | none (pass it from a secret) |
| `github-token` | no | `github.token` |

## Development

```
npm install
npm test        # build + unit tests (CLI, GitHub and artifact calls are mocked)
npm run lint
npm run package # bundle into dist/ with ncc; commit dist/ when releasing
```

The package is ESM (`"type": "module"`), as required by `@actions/*` v3+.
