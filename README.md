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

- [DigitalOcean account](https://cloud.digitalocean.com/)
- [DigitalOcean Container Registry](https://docs.digitalocean.com/products/container-registry/)
- [doctl CLI](https://docs.digitalocean.com/reference/doctl/how-to/install/) installed and authenticated
- [DO Serverless Functions](https://docs.digitalocean.com/products/functions/) connected to your account

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/ktamas77/do-registry-housekeeper.git
cd do-registry-housekeeper
```

### 2. Create a DigitalOcean API Token

1. Go to [API Tokens](https://cloud.digitalocean.com/account/api/tokens) in your DO account
2. Click "Generate New Token"
3. Give it a name (e.g., "registry-housekeeper")
4. Select **Read** and **Write** scopes (needs write to delete tags)
5. Copy the generated token

### 3. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
DO_API_TOKEN=your_digitalocean_api_token_here
DO_REGISTRY_NAME=your_registry_name
MAX_TAGS_TO_KEEP=10
DRY_RUN=false
```

| Variable           | Required | Default | Description                                                                           |
| ------------------ | -------- | ------- | ------------------------------------------------------------------------------------- |
| `DO_API_TOKEN`     | Yes      | -       | Your DigitalOcean API token                                                           |
| `DO_REGISTRY_NAME` | Yes      | -       | Your registry name (e.g., `my-registry` from `registry.digitalocean.com/my-registry`) |
| `MAX_TAGS_TO_KEEP` | No       | `10`    | Number of most recent tags to keep per repository                                     |
| `DRY_RUN`          | No       | `false` | Set to `true` to preview deletions without actually deleting                          |

### 4. Connect to DO Functions (First Time Only)

If you haven't used DO Functions before:

```bash
# Install serverless support
doctl serverless install

# Create a new namespace (or use an existing one)
doctl serverless namespaces create --label registry-housekeeper --region nyc1

# Or connect to an existing namespace
doctl serverless connect
```

### 5. Deploy

```bash
doctl serverless deploy .
```

### 6. Set Up Scheduled Trigger (Optional)

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
doctl serverless functions invoke registry-housekeeper/housekeeper
```

### View Logs

```bash
doctl serverless activations logs --last
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

1. Set `DRY_RUN=true` in your `.env`
2. Deploy: `doctl serverless deploy .`
3. Run: `doctl serverless functions invoke registry-housekeeper/housekeeper`
4. Check logs to see what would be removed
5. When satisfied, set `DRY_RUN=false` and redeploy

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

Then redeploy with `doctl serverless deploy .`

## Troubleshooting

### "DO_API_TOKEN environment variable is required"

Make sure your `.env` file exists and contains a valid token, then redeploy.

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
doctl serverless functions invoke registry-housekeeper/housekeeper --no-wait
# Returns: {"activationId": "abc123..."}

# Check result (after a minute or so)
doctl serverless activations result abc123...
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.
