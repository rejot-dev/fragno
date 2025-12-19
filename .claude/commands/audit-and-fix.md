Run `pnpm audit --fix` to check for security vulnerabilities and apply fixes.

If the audit adds overrides to package.json, follow this procedure to update the actual packages
instead:

1. For each override added, run `pnpm why <package-name> --recursive` to find where the package is
   used
2. **IMPORTANT**: The "Patched versions" shown by `pnpm audit` only shows the latest patched version
   (e.g., `>=16.0.9`), but patches for older major versions often exist. **Always check the GitHub
   advisory** (the "More info" link) to see all patched versions across different majors. For
   example, an advisory might show patches for 15.0.6, 15.1.10, 15.2.7, etc., not just 16.0.9.
3. Update the package in its respective workspace, preferring to stay on the current major version:
   - First, check if a patch exists for your current major version in the GitHub advisory
   - Try patch update within current major:
     `pnpm --filter <workspace-name> update <package-name>@~<current-version>` (e.g., `@~15.1.0`
     allows 15.1.x)
   - If no patch for current minor, try another minor within the same major per the advisory
   - Only update to a new major version as a last resort when no patch exists for your current major
4. Verify the new version meets the security requirement with `pnpm why <package-name> --recursive`
5. Remove the override from the root package.json (keep any pre-existing overrides)
6. Run `pnpm audit` to confirm no vulnerabilities remain

Notes:

- Low severity issues do not need to be fixed
- For transitive dependencies, first try updating the parent package to a newer patch/minor version
  that may include the fix. Only use overrides if the parent package hasn't released a fix yet.
- If a package is already at an acceptable version, the override is unnecessary and should be
  removed
