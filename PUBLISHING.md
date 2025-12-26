# Publishing to npm

## Prerequisites

You need an npm account. If you don't have one:
1. Sign up at https://www.npmjs.com/signup
2. Verify your email

## Publishing Steps

1. **Login to npm:**
   ```bash
   npm login
   ```
   Enter your username, password, and email.

2. **Check if package name is available:**
   ```bash
   npm view pmtiles-contour-server
   ```
   If it shows "npm error 404", the name is available!

3. **Publish the package:**
   ```bash
   npm publish --access public
   ```

4. **Test the published package:**
   ```bash
   npx pmtiles-contour-server /path/to/terrain.pmtiles
   ```

## After Publishing

Users can run your server with:
```bash
# Run directly with npx (no installation needed)
npx pmtiles-contour-server terrain.pmtiles

# Or install globally
npm install -g pmtiles-contour-server
pmtiles-contour-server terrain.pmtiles

# With environment variables
PORT=8099 CONTOUR_INTERVAL=20 npx pmtiles-contour-server terrain.pmtiles
```

## Updating

When you make changes:
1. Update version in package.json (e.g., 1.0.0 → 1.0.1)
2. Commit changes
3. Run `npm publish` again

## Version Guidelines

- Patch (1.0.0 → 1.0.1): Bug fixes
- Minor (1.0.0 → 1.1.0): New features, backward compatible
- Major (1.0.0 → 2.0.0): Breaking changes
