import express from 'express';
import cors from 'cors';
import { PMTiles } from 'pmtiles';
import { contours } from 'd3-contour';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import sharp from 'sharp';
import { open, readdir, stat } from 'fs/promises';
import { resolve, join, basename, extname } from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
const pmtilesDir = args[0];

if (!pmtilesDir) {
  console.error('Usage: node server.js <path-to-directory>');
  console.error('Example: node server.js ./pmtiles-data');
  process.exit(1);
}

// Validate that the path is a directory
const pmtilesDirPath = resolve(pmtilesDir);
try {
  const stats = await stat(pmtilesDirPath);
  if (!stats.isDirectory()) {
    console.error(`Error: ${pmtilesDir} is not a directory`);
    console.error('Please provide a path to a directory containing .pmtiles files');
    process.exit(1);
  }
} catch (error) {
  console.error(`Error: Cannot access ${pmtilesDir}`);
  console.error(error.message);
  process.exit(1);
}

// Configuration
const PORT = process.env.PORT || 3000;
const ENCODING = process.env.ENCODING || 'terrarium'; // 'terrarium' or 'mapbox'
const CONTOUR_INTERVAL = parseInt(process.env.CONTOUR_INTERVAL || '10'); // meters
const MAJOR_INTERVAL = parseInt(process.env.MAJOR_INTERVAL || '50'); // meters

// Note: Tile dimensions are read from the actual DEM image (imageData.width/height)
// Common sizes are 256x256 or 512x512 pixels

// Load all PMTiles files from a directory
async function loadPMTiles(directory) {
  const files = await readdir(directory);
  const pmtilesFiles = files.filter(file => extname(file).toLowerCase() === '.pmtiles');

  if (pmtilesFiles.length === 0) {
    console.error(`Error: No .pmtiles files found in ${directory}`);
    console.error('Please ensure the directory contains at least one .pmtiles file');
    process.exit(1);
  }

  const tilesets = new Map();

  for (const file of pmtilesFiles) {
    const filePath = join(directory, file);
    const tilesetName = basename(file, '.pmtiles');
    const fileSource = new FileSource(filePath);
    const pmtiles = new PMTiles(fileSource);

    tilesets.set(tilesetName, pmtiles);
    console.log(`Loaded tileset: ${tilesetName} (${file})`);
  }

  return tilesets;
}

// Custom FileSource for reading local PMTiles files
class FileSource {
  constructor(path) {
    this.path = resolve(path);
    this.fileHandle = null;
  }

  async getKey() {
    return this.path;
  }

  async getBytes(offset, length) {
    if (!this.fileHandle) {
      this.fileHandle = await open(this.path, 'r');
    }

    const buffer = Buffer.allocUnsafe(length);
    await this.fileHandle.read(buffer, 0, length, offset);

    // Convert Buffer to ArrayBuffer for PMTiles
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );

    return {
      data: arrayBuffer,
      etag: undefined,
      cacheControl: undefined,
      expires: undefined
    };
  }
}

// Load all PMTiles files from the directory
const tilesets = await loadPMTiles(pmtilesDirPath);

// Decode image from tile buffer (supports PNG, WebP, JPEG)
async function decodeImage(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: new Uint8ClampedArray(data),
    width: info.width,
    height: info.height
  };
}

// Decode elevation from RGB values
function decodeElevation(r, g, b, encoding) {
  if (encoding === 'terrarium') {
    return r * 256 + g + b / 256 - 32768;
  } else if (encoding === 'mapbox') {
    return -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1);
  }
  throw new Error(`Unknown encoding: ${encoding}`);
}

// Generate contours from elevation data
function generateContours(imageData, width, height, encoding, minInterval, majorInterval) {
  const elevations = new Float64Array(width * height);

  let minEle = Infinity;
  let maxEle = -Infinity;

  for (let i = 0; i < width * height; i++) {
    const pixelIndex = i * 4;
    const r = imageData[pixelIndex];
    const g = imageData[pixelIndex + 1];
    const b = imageData[pixelIndex + 2];

    const elevation = decodeElevation(r, g, b, encoding);
    elevations[i] = elevation;

    if (elevation < minEle) minEle = elevation;
    if (elevation > maxEle) maxEle = elevation;
  }

  console.log(`Tile elevation range: ${minEle.toFixed(1)}m - ${maxEle.toFixed(1)}m`);

  // Generate threshold values
  const thresholds = [];
  const minorStart = Math.ceil(minEle / minInterval) * minInterval;
  const majorStart = Math.ceil(minEle / majorInterval) * majorInterval;

  for (let ele = minorStart; ele <= maxEle; ele += minInterval) {
    thresholds.push(ele);
  }

  // Generate contours
  const contourGenerator = contours()
    .size([width, height])
    .thresholds(thresholds);

  const contourFeatures = contourGenerator(elevations);

  console.log(`Generated ${contourFeatures.length} contour features`);

  return contourFeatures.map(feature => ({
    ...feature,
    isMajor: Math.abs(feature.value % majorInterval) < 0.01
  }));
}

// Calculate tile bounds in geographic coordinates
function tileBounds(z, x, y) {
  const n = Math.pow(2, z);
  const lon1 = (x / n) * 360 - 180;
  const lon2 = ((x + 1) / n) * 360 - 180;
  const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const lat2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { west: lon1, south: lat2, east: lon2, north: lat1 };
}

// Encode contours to MVT
function encodeMVT(contourFeatures, width, height, z, x, y) {
  const extent = 4096;
  const features = [];

  for (const contour of contourFeatures) {
    if (!contour.coordinates || contour.coordinates.length === 0) continue;

    const ele = Math.round(contour.value);
    const level = contour.isMajor ? 1 : 0;

    // d3-contour returns MultiPolygon, so coordinates is array of polygons
    // Each polygon is an array of rings, each ring is an array of [x, y] points
    for (const polygon of contour.coordinates) {
      for (const ring of polygon) {
        const geometry = [];
        for (const [px, py] of ring) {
          const tileX = Math.round((px / width) * extent);
          const tileY = Math.round((py / height) * extent);
          geometry.push([tileX, tileY]);
        }

        if (geometry.length > 1) {
          features.push({
            geometry: [geometry],
            type: 2, // LineString in geojson-vt format
            tags: { ele, level }
          });
        }
      }
    }
  }

  console.log(`Encoding ${features.length} LineString features to MVT`);

  // Build tile in geojson-vt format manually
  const tile = {
    features,
    numPoints: features.reduce((sum, f) => sum + f.geometry[0].length, 0),
    numSimplified: 0,
    numFeatures: features.length,
    source: null,
    x,
    y,
    z,
    transformed: false,
    minX: 0,
    minY: 0,
    maxX: extent,
    maxY: extent
  };

  // Encode to MVT protobuf
  const buffer = vtpbf.fromGeojsonVt({ contours: tile }, { version: 2 });
  console.log(`MVT buffer: ${buffer.length} bytes, type: ${typeof buffer}, isBuffer: ${Buffer.isBuffer(buffer)}`);

  if (!Buffer.isBuffer(buffer)) {
    console.log('WARNING: vt-pbf returned non-buffer:', buffer.constructor.name);
    return Buffer.from(buffer);
  }

  return buffer;
}

// Initialize Express
const app = express();

// Enable CORS for all routes
app.use(cors());

// Fetch tile with neighbors for buffered contour generation
async function fetchTileWithBuffer(pmtiles, z, x, y) {
  const tiles = [];
  const positions = [];

  // Fetch 3x3 grid of tiles (center + 8 neighbors)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tileX = x + dx;
      const tileY = y + dy;

      try {
        const tileResult = await pmtiles.getZxy(z, tileX, tileY);
        if (tileResult) {
          const imageBuffer = Buffer.from(tileResult.data);
          const { data, width, height } = await decodeImage(imageBuffer);
          tiles.push({ data, width, height, x: dx, y: dy });
          positions.push({ x: dx, y: dy });
        } else {
          tiles.push(null);
          positions.push({ x: dx, y: dy });
        }
      } catch (error) {
        tiles.push(null);
        positions.push({ x: dx, y: dy });
      }
    }
  }

  return { tiles, positions };
}

// Stitch tiles into a larger image with optional buffer-only extraction
function stitchTiles(tiles, positions, bufferPixels = 1) {
  // Find a valid tile to get dimensions
  const validTile = tiles.find(t => t !== null);
  if (!validTile) return null;

  const tileWidth = validTile.width;
  const tileHeight = validTile.height;

  // Extract only center tile + buffer (like maplibre-contour does)
  // This gives us: [tileWidth - buffer] to [tileWidth + tileWidth + buffer]
  const extractWidth = tileWidth + bufferPixels * 2;
  const extractHeight = tileHeight + bufferPixels * 2;
  const extractData = new Uint8ClampedArray(extractWidth * extractHeight * 4);

  // Fill with neutral elevation
  for (let i = 0; i < extractData.length; i += 4) {
    extractData[i] = 128;     // R
    extractData[i + 1] = 128; // G
    extractData[i + 2] = 128; // B
    extractData[i + 3] = 255; // A
  }

  // Copy data from the 9 tiles, but only extract center tile + buffer region
  const stitchedWidth = tileWidth * 3;
  const centerOffsetX = tileWidth;  // Center tile starts at x=512 in 1536 grid
  const centerOffsetY = tileHeight;

  // Source region in stitched coordinates
  const srcMinX = centerOffsetX - bufferPixels;
  const srcMaxX = centerOffsetX + tileWidth + bufferPixels;
  const srcMinY = centerOffsetY - bufferPixels;
  const srcMaxY = centerOffsetY + tileHeight + bufferPixels;

  // First, stitch into temporary buffer
  const stitchedData = new Uint8ClampedArray(stitchedWidth * stitchedWidth * 4);
  for (let i = 0; i < stitchedData.length; i += 4) {
    stitchedData[i] = 128;
    stitchedData[i + 1] = 128;
    stitchedData[i + 2] = 128;
    stitchedData[i + 3] = 255;
  }

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (!tile) continue;

    const pos = positions[i];
    const offsetX = (pos.x + 1) * tileWidth;
    const offsetY = (pos.y + 1) * tileHeight;

    for (let py = 0; py < tile.height; py++) {
      for (let px = 0; px < tile.width; px++) {
        const srcIdx = (py * tile.width + px) * 4;
        const dstX = offsetX + px;
        const dstY = offsetY + py;
        const dstIdx = (dstY * stitchedWidth + dstX) * 4;

        stitchedData[dstIdx] = tile.data[srcIdx];
        stitchedData[dstIdx + 1] = tile.data[srcIdx + 1];
        stitchedData[dstIdx + 2] = tile.data[srcIdx + 2];
        stitchedData[dstIdx + 3] = tile.data[srcIdx + 3];
      }
    }
  }

  // Extract only the center tile + buffer region
  for (let y = 0; y < extractHeight; y++) {
    for (let x = 0; x < extractWidth; x++) {
      const srcX = srcMinX + x;
      const srcY = srcMinY + y;
      const srcIdx = (srcY * stitchedWidth + srcX) * 4;
      const dstIdx = (y * extractWidth + x) * 4;

      extractData[dstIdx] = stitchedData[srcIdx];
      extractData[dstIdx + 1] = stitchedData[srcIdx + 1];
      extractData[dstIdx + 2] = stitchedData[srcIdx + 2];
      extractData[dstIdx + 3] = stitchedData[srcIdx + 3];
    }
  }

  return {
    data: extractData,
    width: extractWidth,
    height: extractHeight,
    tileWidth,
    tileHeight,
    buffer: bufferPixels
  };
}

// Clip contours generated on buffered tile to output tile bounds
function clipContoursToTile(contourFeatures, tileWidth, tileHeight, buffer) {
  // Contours are generated on image of size (tileWidth + 2*buffer)
  // We need to translate them so buffer region maps outside [0, tileWidth]
  // Points at buffer position should map to 0, points at (tileWidth+buffer) should map to tileWidth

  const clippedFeatures = [];

  for (const feature of contourFeatures) {
    if (!feature.coordinates || feature.coordinates.length === 0) continue;

    const clippedCoordinates = [];

    for (const polygon of feature.coordinates) {
      const clippedPolygon = [];

      for (const ring of polygon) {
        const clippedRing = [];

        for (const [x, y] of ring) {
          // Translate coordinates: buffer pixels should become 0
          const tx = x - buffer;
          const ty = y - buffer;

          // Keep all points (including those in buffer zone that extend beyond tile)
          // MVT encoding will handle values outside [0, tileWidth] naturally
          clippedRing.push([tx, ty]);
        }

        // Keep rings with enough points
        if (clippedRing.length > 1) {
          clippedPolygon.push(clippedRing);
        }
      }

      if (clippedPolygon.length > 0) {
        clippedCoordinates.push(clippedPolygon);
      }
    }

    if (clippedCoordinates.length > 0) {
      clippedFeatures.push({
        ...feature,
        coordinates: clippedCoordinates
      });
    }
  }

  return clippedFeatures;
}

// Catalog endpoint - list all available tilesets
app.get('/', async (req, res) => {
  try {
    const host = req.get('host');
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}`;

    const catalog = [];

    for (const [name, pmtiles] of tilesets) {
      try {
        const header = await pmtiles.getHeader();
        const metadata = await pmtiles.getMetadata();

        catalog.push({
          name,
          tilejson: `${baseUrl}/${name}.json`,
          tiles: `${baseUrl}/${name}/{z}/{x}/{y}.mvt`,
          bounds: [
            header.minLon || -180,
            header.minLat || -85.0511,
            header.maxLon || 180,
            header.maxLat || 85.0511
          ],
          minzoom: header.minZoom || 0,
          maxzoom: header.maxZoom || 14,
          description: metadata?.description || 'Contour lines generated from DEM data'
        });
      } catch (error) {
        console.error(`Error reading metadata for ${name}:`, error);
        catalog.push({
          name,
          error: 'Failed to read metadata',
          tilejson: `${baseUrl}/${name}.json`
        });
      }
    }

    res.json({
      tilesets: catalog,
      count: tilesets.size
    });
  } catch (error) {
    console.error('Error generating catalog:', error);
    res.status(500).json({ error: 'Failed to generate catalog' });
  }
});

// Tile request handler
app.get('/:tileset/:z/:x/:y.mvt', async (req, res) => {
  try {
    const tileset = req.params.tileset;
    const z = parseInt(req.params.z);
    const x = parseInt(req.params.x);
    const y = parseInt(req.params.y);

    // Lookup PMTiles instance
    const pmtiles = tilesets.get(tileset);
    if (!pmtiles) {
      return res.status(404).json({
        error: 'Tileset not found',
        tileset,
        available: Array.from(tilesets.keys())
      });
    }

    console.log(`Requesting tile: ${tileset}/${z}/${x}/${y}`);

    // Fetch tile with neighbors
    const { tiles, positions } = await fetchTileWithBuffer(pmtiles, z, x, y);

    // Stitch tiles together with buffer (like maplibre-contour buffer=1)
    const bufferPixels = 1;
    const stitched = stitchTiles(tiles, positions, bufferPixels);

    if (!stitched) {
      return res.status(404).send('Tile not found');
    }

    // Generate contours on the buffered tile (tileWidth + 2*buffer pixels)
    const contourFeatures = generateContours(
      stitched.data,
      stitched.width,
      stitched.height,
      ENCODING,
      CONTOUR_INTERVAL,
      MAJOR_INTERVAL
    );

    // Clip/translate contours to tile coordinates
    const clippedFeatures = clipContoursToTile(
      contourFeatures,
      stitched.tileWidth,
      stitched.tileHeight,
      stitched.buffer
    );

    // Encode to MVT using the original tile dimensions
    const mvtBuffer = encodeMVT(clippedFeatures, stitched.tileWidth, stitched.tileHeight, z, x, y);

    if (mvtBuffer.length === 0) {
      return res.status(204).send(); // No content
    }

    console.log(`Generated contour tile: ${mvtBuffer.length} bytes`);

    res.set('Content-Type', 'application/x-protobuf');
    res.send(mvtBuffer);

  } catch (error) {
    console.error('Error processing tile:', error);
    res.status(500).send('Internal server error');
  }
});

// TileJSON endpoint
app.get('/:tileset.json', async (req, res) => {
  try {
    const tileset = req.params.tileset;

    // Lookup PMTiles instance
    const pmtiles = tilesets.get(tileset);
    if (!pmtiles) {
      return res.status(404).json({
        error: 'Tileset not found',
        tileset,
        available: Array.from(tilesets.keys())
      });
    }

    const metadata = await pmtiles.getMetadata();
    const header = await pmtiles.getHeader();

    const host = req.get('host');
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}`;

    const tilejson = {
      tilejson: '3.0.0',
      name: metadata?.name || tileset,
      description: 'Contour lines generated from DEM data',
      version: '1.0.0',
      scheme: 'xyz',
      tiles: [`${baseUrl}/${tileset}/{z}/{x}/{y}.mvt`],
      minzoom: header.minZoom || 0,
      maxzoom: header.maxZoom || 14,
      bounds: [
        header.minLon || -180,
        header.minLat || -85.0511,
        header.maxLon || 180,
        header.maxLat || 85.0511
      ],
      center: [
        ((header.minLon || -180) + (header.maxLon || 180)) / 2,
        ((header.minLat || -85.0511) + (header.maxLat || 85.0511)) / 2,
        header.centerZoom || Math.floor((header.minZoom + header.maxZoom) / 2)
      ],
      vector_layers: [
        {
          id: 'contours',
          description: 'Elevation contour lines',
          minzoom: header.minZoom || 0,
          maxzoom: header.maxZoom || 14,
          fields: {
            ele: 'Number - Elevation in meters',
            level: 'Number - 0 for minor contours, 1 for major contours'
          }
        }
      ],
      attribution: metadata?.attribution || ''
    };

    res.json(tilejson);
  } catch (error) {
    console.error('Error generating TileJSON:', error);
    res.status(500).json({ error: 'Failed to generate TileJSON' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    directory: pmtilesDirPath,
    tilesets: Array.from(tilesets.keys()),
    count: tilesets.size
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`PMTiles Contour Server running on port ${PORT}`);
  console.log(`Directory: ${pmtilesDirPath}`);
  console.log(`Tilesets loaded: ${tilesets.size}`);
  for (const name of tilesets.keys()) {
    console.log(`  - ${name}`);
  }
  console.log(`Encoding: ${ENCODING}`);
  console.log(`Contour interval: ${CONTOUR_INTERVAL}m (major: ${MAJOR_INTERVAL}m)`);
  console.log(`\nEndpoints:`);
  console.log(`  Catalog: http://localhost:${PORT}/`);
  console.log(`  TileJSON: http://localhost:${PORT}/{tileset}.json`);
  console.log(`  Tiles: http://localhost:${PORT}/{tileset}/{z}/{x}/{y}.mvt`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  if (tilesets.size > 0) {
    const firstTileset = Array.from(tilesets.keys())[0];
    console.log(`\nExample URLs (using "${firstTileset}"):`);
    console.log(`  http://localhost:${PORT}/${firstTileset}.json`);
    console.log(`  http://localhost:${PORT}/${firstTileset}/12/2048/2048.mvt`);
  }
});
