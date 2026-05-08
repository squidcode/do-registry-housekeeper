# DigitalOcean Registry Housekeeper

A DigitalOcean Function that automatically cleans up old container image tags from your DO Container Registry. It keeps only the N most recent tags per repository, helping you manage storage costs and keep your registry tidy.

## Features

- Automatically untags old container images (removes tag references)
- Configurable number of tags to keep per repository
- Keeps the most recent tags based on timestamp
- Dry run mode to preview changes before applying
- Scheduled execution via DO Console triggers
- Zero external dependencies (uses native Node.js fetch)

## Prerequisites

- [DigitalOcean account](https://cloud.digitalocean.com/) (the `squidcode` team)
- [doctl CLI](https://docs.digitalocean.com/reference/doctl/how-to/install/), authenticated with a `squidcode` context (`doctl auth init --context squidcode`)
- [Doppler CLI](https://docs.doppler.com/docs/cli), logged in to the Squidcode workplace
- Node.js + npm

## Setup

### 1. Clone the Repository

```bash
git clone git@github.com:squidcode/do-registry-housekeeper.git
cd do-registry-housekeeper
npm install
```

### 2. Configure Secrets (Doppler)

Secrets live in Doppler — no `.env` file is needed. The repo is scoped to `squidcode-do-registry-housekeeper@prd` (see `.doppler.yaml` / `~/.doppler/.doppler.yaml`); `doppler secrets` from inside the repo lists the four expected keys:

| Variable           | Required | Default | Description                                                                      |
| ------------------ | -------- | ------- | -------------------------------------------------------------------------------- |
| `DO_API_TOKEN`     | Yes      | -       | DigitalOcean API token (Read + Write scopes — needed to untag images)            |
| `DO_REGISTRY_NAME` | Yes      | -       | Registry name (e.g., `my-registry` from `registry.digitalocean.com/my-registry`) |
| `MAX_TAGS_TO_KEEP` | No       | `10`    | Number of most recent tags to keep per repository                                |
| `DRY_RUN`          | No       | `false` | `true` to preview deletions without applying                                     |

To rotate the DO token: generate a new one in the DO console, then `doppler secrets set DO_API_TOKEN=...` (or update via the Doppler dashboard), then redeploy with `npm run deploy`.

### 3. Connect to the DO Functions Namespace (First Time Only)

```bash
npm run connect
```

Wraps `doctl --context squidcode serverless connect registry-housekeeper`. The namespace already exists in `nyc1` (`fn-c6719ebd-…`); this just points your local `doctl` cache at it.

### 4. Deploy

```bash
npm run deploy
```

Equivalent to `doppler run -- doctl --context squidcode serverless deploy .`. Doppler injects the four secrets into the deploy process; `project.yml` interpolates them into the function's runtime env.

For a deploy with `DRY_RUN=true` overriding whatever's in Doppler:

```bash
npm run deploy:dry
```

### 5. Set Up Scheduled Trigger (Optional)

To run the function automatically on a schedule, create a trigger via the DO Console:

1. Go to [Functions](https://cloud.digitalocean.com/functions) in your DO account
2. Select your namespace → `registry-housekeeper` package → `housekeeper` function
3. Click **Triggers** tab → **Create Trigger**
4. Select **Scheduled** and enter a cron expression (e.g., `0 3 * * *` for daily at 3 AM UTC)
5. Save the trigger

> **Note**: Scheduled triggers defined in `project.yml` may fail to deploy due to DO API limitations. Setting up triggers via the console is more reliable.

## Usage

### Automatic Execution

If you set up a scheduled trigger (Step 6 above), the function runs automatically at your configured time.

### Manual Execution

Test the function manually:

```bash
npm run invoke
```

### View Logs

```bash
npm run logs
```

## How It Works

1. Lists all repositories in your container registry
2. For each repository, lists all tags
3. Sorts tags by `updated_at` timestamp (newest first)
4. If a repository has more tags than `MAX_TAGS_TO_KEEP`:
   - Keeps the N most recent tags
   - Untags (removes references to) the older ones
5. Returns a summary of actions taken

### Important: Untagging vs Deleting

This function **untags** images - it removes the tag reference, not the actual image data. The image layers remain in your registry until **garbage collection (GC)** runs.

- **Untagging**: Removes the tag name (e.g., `v1.0.0`) pointing to an image manifest
- **Garbage Collection**: Actually deletes unreferenced image data and frees storage

To free storage after untagging, either:

- Wait for DO's automatic GC (runs periodically)
- Trigger GC manually from the [Container Registry page](https://cloud.digitalocean.com/registry) → **Settings** → **Start Garbage Collection**

### Other Notes

- **Latest Tag**: The `latest` tag is treated like any other tag - if it's not among the N most recent, it will be removed. Consider this when setting `MAX_TAGS_TO_KEEP`.
- **Shared Manifests**: Tags pointing to the same manifest (digest) are handled individually based on their timestamps.

## Testing with Dry Run

Before enabling actual untagging, test with dry run mode:

1. `npm run deploy:dry` (overrides Doppler's `DRY_RUN` to `true` for this deploy only)
2. `npm run invoke`
3. `npm run logs` — confirm the listed `tagsRemoved` entries match what you expect
4. When satisfied, `npm run deploy` to redeploy with the Doppler-stored `DRY_RUN` value (`false` in prd)

## Example Output

```json
{
  "statusCode": 200,
  "body": {
    "registryName": "my-registry",
    "maxTagsToKeep": 10,
    "dryRun": false,
    "repositories": [
      {
        "name": "my-app",
        "tagsFound": 25,
        "tagsRemoved": ["v1.0.0", "v1.0.1", "v1.0.2"],
        "tagsKept": ["v1.2.0", "v1.1.9", "v1.1.8", "..."]
      }
    ],
    "totalTagsRemoved": 15,
    "errors": []
  }
}
```

## Customization

### Change the Schedule

Edit the scheduled trigger in the DO Console (Functions → your namespace → housekeeper → Triggers). Common cron expressions:

```
0 3 * * *     # Daily at 3 AM UTC
0 */6 * * *   # Every 6 hours
0 0 * * 0     # Weekly on Sunday at midnight
```

### Adjust Timeout

The default timeout is 120 seconds (2 minutes), which handles most registries. For very large registries with many repositories and tags, you can increase it in `project.yml`:

```yaml
limits:
  timeout: 180000 # 3 minutes
  memory: 256
```

Then redeploy with `npm run deploy`.

## Troubleshooting

### "DO_API_TOKEN environment variable is required"

Doppler isn't injecting secrets into the deploy. Check:

- `doppler whoami` — are you logged in?
- `doppler secrets` (run from the repo root) — does it show `DO_API_TOKEN`?
- Did you use `npm run deploy` (Doppler-wrapped) rather than a bare `doctl serverless deploy .`?

### "DO API error (401)"

Your API token is invalid or expired. Generate a new one.

### "DO API error (404)"

The registry name is incorrect. Check that `DO_REGISTRY_NAME` matches your registry exactly.

### Function times out

Increase the timeout in `project.yml` (see Customization section) and redeploy.

### Trigger deployment fails with 422 error

This is a known issue with DO Functions scheduler triggers. Set up the trigger manually via the DO Console instead (see Step 6 in Setup).

### "Request accepted, but processing not completed yet"

For large registries, the function may run asynchronously. Use `--no-wait` to get the activation ID, then check results:

```bash
doctl --context squidcode serverless functions invoke registry-housekeeper/housekeeper --no-wait
# Returns: {"activationId": "abc123..."}

# Check result (after a minute or so)
doctl --context squidcode serverless activations result abc123...
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.
