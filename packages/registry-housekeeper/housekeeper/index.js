/**
 * DigitalOcean Registry Housekeeper
 *
 * Cleans up old container image tags from DigitalOcean Container Registry,
 * keeping only the N most recent tags per repository.
 */

const DO_API_BASE = 'https://api.digitalocean.com/v2';

/**
 * Make an authenticated request to the DigitalOcean API
 */
async function doApiRequest(endpoint, options = {}) {
  const token = process.env.DO_API_TOKEN;
  if (!token) {
    throw new Error('DO_API_TOKEN environment variable is required');
  }

  const url = `${DO_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`DO API error (${response.status}): ${errorBody}`);
  }

  // DELETE requests may return 204 No Content
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

/**
 * List all repositories in the registry
 */
async function listRepositories(registryName) {
  const repositories = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await doApiRequest(
      `/registry/${registryName}/repositoriesV2?page=${page}&per_page=${perPage}`
    );

    if (response.repositories && response.repositories.length > 0) {
      repositories.push(...response.repositories);
    }

    // Check if there are more pages
    if (!response.links?.pages?.next) {
      break;
    }
    page++;
  }

  return repositories;
}

/**
 * List all tags for a repository
 */
async function listTags(registryName, repositoryName) {
  const tags = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await doApiRequest(
      `/registry/${registryName}/repositories/${repositoryName}/tags?page=${page}&per_page=${perPage}`
    );

    if (response.tags && response.tags.length > 0) {
      tags.push(...response.tags);
    }

    // Check if there are more pages
    if (!response.links?.pages?.next) {
      break;
    }
    page++;
  }

  return tags;
}

/**
 * Remove a tag from a repository (untag).
 * This removes the tag reference but doesn't delete the image data.
 * Image data is removed when garbage collection runs.
 */
async function untagImage(registryName, repositoryName, tag) {
  await doApiRequest(
    `/registry/${registryName}/repositories/${repositoryName}/tags/${tag}`,
    { method: 'DELETE' }
  );
}

/**
 * Main function entry point
 */
async function main(args) {
  const registryName = process.env.DO_REGISTRY_NAME;
  const maxTags = parseInt(process.env.MAX_TAGS_TO_KEEP || '10', 10);
  const dryRun = process.env.DRY_RUN === 'true';

  // Validate configuration
  if (!registryName) {
    return {
      statusCode: 400,
      body: { error: 'DO_REGISTRY_NAME environment variable is required' }
    };
  }

  if (!process.env.DO_API_TOKEN) {
    return {
      statusCode: 400,
      body: { error: 'DO_API_TOKEN environment variable is required' }
    };
  }

  if (isNaN(maxTags) || maxTags < 1) {
    return {
      statusCode: 400,
      body: { error: 'MAX_TAGS_TO_KEEP must be a positive integer' }
    };
  }

  console.log(`Starting cleanup for registry: ${registryName}`);
  console.log(`Max tags to keep per repository: ${maxTags}`);
  console.log(`Dry run: ${dryRun}`);

  const results = {
    registryName,
    maxTagsToKeep: maxTags,
    dryRun,
    repositories: [],
    totalTagsRemoved: 0,
    errors: []
  };

  try {
    // List all repositories
    const repositories = await listRepositories(registryName);
    console.log(`Found ${repositories.length} repositories`);

    for (const repo of repositories) {
      const repoName = repo.name;
      const repoResult = {
        name: repoName,
        tagsFound: 0,
        tagsRemoved: [],
        tagsKept: []
      };

      try {
        // List all tags for this repository
        const tags = await listTags(registryName, repoName);
        repoResult.tagsFound = tags.length;
        console.log(`Repository ${repoName}: ${tags.length} tags found`);

        if (tags.length <= maxTags) {
          console.log(`  Skipping: ${tags.length} tags <= ${maxTags} max`);
          repoResult.tagsKept = tags.map(t => t.tag);
          results.repositories.push(repoResult);
          continue;
        }

        // Sort tags by updated_at timestamp (newest first)
        const sortedTags = tags.sort((a, b) => {
          const dateA = new Date(a.updated_at);
          const dateB = new Date(b.updated_at);
          return dateB - dateA;
        });

        // Keep the newest tags, untag the rest
        const tagsToKeep = sortedTags.slice(0, maxTags);
        const tagsToRemove = sortedTags.slice(maxTags);

        repoResult.tagsKept = tagsToKeep.map(t => t.tag);

        console.log(`  Keeping ${tagsToKeep.length} newest tags`);
        console.log(`  Removing ${tagsToRemove.length} old tags`);

        for (const tagObj of tagsToRemove) {
          const tagName = tagObj.tag;

          if (dryRun) {
            console.log(`  [DRY RUN] Would remove: ${tagName}`);
            repoResult.tagsRemoved.push(tagName);
          } else {
            try {
              await untagImage(registryName, repoName, tagName);
              console.log(`  Removed: ${tagName}`);
              repoResult.tagsRemoved.push(tagName);
              results.totalTagsRemoved++;
            } catch (untagError) {
              console.error(`  Failed to remove ${tagName}: ${untagError.message}`);
              results.errors.push({
                repository: repoName,
                tag: tagName,
                error: untagError.message
              });
            }
          }
        }
      } catch (repoError) {
        console.error(`Error processing repository ${repoName}: ${repoError.message}`);
        results.errors.push({
          repository: repoName,
          error: repoError.message
        });
      }

      results.repositories.push(repoResult);
    }

    console.log(`\nCleanup complete. Total tags removed: ${results.totalTagsRemoved}`);

    return {
      statusCode: 200,
      body: results
    };

  } catch (error) {
    console.error(`Fatal error: ${error.message}`);
    return {
      statusCode: 500,
      body: {
        error: error.message,
        results
      }
    };
  }
}

module.exports = { main };
