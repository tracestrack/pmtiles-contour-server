import { PMTiles } from 'pmtiles';
import { contours } from 'd3-contour';
import vtpbf from 'vt-pbf';
import sharp from 'sharp';
import { open } from 'fs/promises';
import { resolve } from 'path';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

// Configuration
const PMTILES_PATH = '/mnt/storagebox/pmtiles/terrainrgb.pmtiles';
const ENCODING = process.env.ENCODING || 'mapbox'; // 'terrarium' or 'mapbox'
const CONTOUR_INTERVAL = parseInt(process.env.CONTOUR_INTERVAL || '20'); // meters
const MAJOR_INTERVAL = parseInt(process.env.MAJOR_INTERVAL || '100'); // meters

// Test tile coordinates - adjust these based on your area of interest
// Example: z=10, x=163, y=395 (somewhere with terrain)
const TEST_Z = 10;
const TEST_X = 163;
const TEST_Y = 395;

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

  async close() {
    if (this.fileHandle) {
      await this.fileHandle.close();
    }
  }
}

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

  // Warn if elevations seem unreasonable
  if (maxEle > 10000 || minEle < -500) {
    console.log('⚠ WARNING: Elevation values seem unusual!');
    console.log('  Consider trying a different ENCODING:');
    console.log('  - Run with: ENCODING=terrarium node test-single-tile.js');
    console.log('  - Or with: ENCODING=mapbox node test-single-tile.js');
  }

  // Generate threshold values
  const thresholds = [];
  const minorStart = Math.ceil(minEle / minInterval) * minInterval;

  for (let ele = minorStart; ele <= maxEle; ele += minInterval) {
    thresholds.push(ele);
  }

  console.log(`Generating contours for ${thresholds.length} elevation levels`);

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

  if (!Buffer.isBuffer(buffer)) {
    return Buffer.from(buffer);
  }

  return buffer;
}

// Validate MVT by decoding it
function validateMVT(mvtBuffer) {
  console.log('\n--- Validating MVT ---');
  console.log(`Buffer size: ${mvtBuffer.length} bytes`);

  try {
    const tile = new VectorTile(new Pbf(mvtBuffer));

    console.log(`Layers in tile: ${Object.keys(tile.layers).join(', ')}`);

    if (tile.layers.contours) {
      const layer = tile.layers.contours;
      console.log(`Contours layer:`);
      console.log(`  - Feature count: ${layer.length}`);
      console.log(`  - Extent: ${layer.extent}`);
      console.log(`  - Version: ${layer.version}`);

      // Sample first few features
      const sampleSize = Math.min(5, layer.length);
      console.log(`\nSample features (first ${sampleSize}):`);

      for (let i = 0; i < sampleSize; i++) {
        const feature = layer.feature(i);
        const geom = feature.loadGeometry();
        console.log(`  Feature ${i}:`);
        console.log(`    - Type: ${feature.type} (2=LineString)`);
        console.log(`    - Properties:`, feature.properties);
        console.log(`    - Geometry rings: ${geom.length}`);
        console.log(`    - Points in first ring: ${geom[0].length}`);
      }

      // Validate structure
      let allValid = true;
      const issues = [];
      const extent = layer.extent;

      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);

        // Check type
        if (feature.type !== 2) {
          issues.push(`Feature ${i}: Invalid type ${feature.type}, expected 2 (LineString)`);
          allValid = false;
        }

        // Check properties
        if (!feature.properties.hasOwnProperty('ele')) {
          issues.push(`Feature ${i}: Missing 'ele' property`);
          allValid = false;
        }
        if (!feature.properties.hasOwnProperty('level')) {
          issues.push(`Feature ${i}: Missing 'level' property`);
          allValid = false;
        }

        // Check geometry
        const geom = feature.loadGeometry();
        if (geom.length === 0) {
          issues.push(`Feature ${i}: Empty geometry`);
          allValid = false;
        }

        // Check coordinates are within reasonable bounds (allow small buffer for seamless tiles)
        const bufferTolerance = extent * 0.05; // 5% buffer is acceptable
        for (let ringIdx = 0; ringIdx < geom.length; ringIdx++) {
          const ring = geom[ringIdx];
          for (let ptIdx = 0; ptIdx < ring.length; ptIdx++) {
            const pt = ring[ptIdx];
            if (pt.x < -bufferTolerance || pt.x > extent + bufferTolerance ||
                pt.y < -bufferTolerance || pt.y > extent + bufferTolerance) {
              issues.push(`Feature ${i}, ring ${ringIdx}, point ${ptIdx}: Coordinate (${pt.x}, ${pt.y}) far outside extent [0, ${extent}] (tolerance: ±${bufferTolerance.toFixed(0)})`);
              allValid = false;
            }
          }
        }
      }

      // Summary of coordinate ranges
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < layer.length; i++) {
        const geom = layer.feature(i).loadGeometry();
        for (const ring of geom) {
          for (const pt of ring) {
            minX = Math.min(minX, pt.x);
            maxX = Math.max(maxX, pt.x);
            minY = Math.min(minY, pt.y);
            maxY = Math.max(maxY, pt.y);
          }
        }
      }
      console.log(`\nCoordinate ranges:`);
      console.log(`  X: ${minX} to ${maxX} (extent: 0 to ${extent})`);
      console.log(`  Y: ${minY} to ${maxY} (extent: 0 to ${extent})`);

      console.log('\n--- Validation Results ---');
      if (allValid) {
        console.log('✓ All features are valid!');
      } else {
        console.log('✗ Validation issues found:');
        issues.slice(0, 10).forEach(issue => console.log(`  - ${issue}`));
        if (issues.length > 10) {
          console.log(`  ... and ${issues.length - 10} more issues`);
        }
      }

      return allValid;
    } else {
      console.log('✗ No "contours" layer found in tile!');
      return false;
    }
  } catch (error) {
    console.error('✗ Failed to decode MVT:', error.message);
    return false;
  }
}

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
  const centerOffsetX = tileWidth;
  const centerOffsetY = tileHeight;

  const srcMinX = centerOffsetX - bufferPixels;
  const srcMinY = centerOffsetY - bufferPixels;

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
  // Translate so buffer pixels map to coordinates outside [0, tileWidth]

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

          // Keep all points (including buffer zone)
          clippedRing.push([tx, ty]);
        }

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

// Main test function
async function testSingleTile() {
  console.log('=== PMTiles Contour Tile Test (with buffering) ===\n');
  console.log(`PMTiles file: ${PMTILES_PATH}`);
  console.log(`Encoding: ${ENCODING}`);
  console.log(`Contour interval: ${CONTOUR_INTERVAL}m (major: ${MAJOR_INTERVAL}m)`);
  console.log(`Test tile: ${TEST_Z}/${TEST_X}/${TEST_Y}\n`);

  const fileSource = new FileSource(PMTILES_PATH);
  const pmtiles = new PMTiles(fileSource);

  try {
    // Get PMTiles metadata
    console.log('--- PMTiles Info ---');
    const header = await pmtiles.getHeader();
    console.log(`Zoom range: ${header.minZoom} - ${header.maxZoom}`);
    console.log(`Bounds: [${header.minLon}, ${header.minLat}, ${header.maxLon}, ${header.maxLat}]`);
    console.log(`Tile type: ${header.tileType}`);
    console.log(`Tile compression: ${header.tileCompression}\n`);

    // Fetch tile with neighbors
    console.log('--- Fetching Tiles (3x3 grid) ---');
    const { tiles, positions } = await fetchTileWithBuffer(pmtiles, TEST_Z, TEST_X, TEST_Y);
    const validCount = tiles.filter(t => t !== null).length;
    console.log(`✓ Fetched ${validCount}/9 tiles\n`);

    // Stitch tiles together with buffer
    console.log('--- Stitching Tiles (maplibre-contour style) ---');
    const bufferPixels = 1;
    const stitched = stitchTiles(tiles, positions, bufferPixels);

    if (!stitched) {
      console.error(`✗ No valid tiles found!`);
      process.exit(1);
    }

    console.log(`✓ Buffered tile: ${stitched.width}x${stitched.height} pixels`);
    console.log(`  (Center ${stitched.tileWidth}x${stitched.tileHeight} + ${stitched.buffer}px buffer on each side)\n`);

    // Generate contours on buffered tile
    console.log('--- Generating Contours ---');
    const contourFeatures = generateContours(
      stitched.data,
      stitched.width,
      stitched.height,
      ENCODING,
      CONTOUR_INTERVAL,
      MAJOR_INTERVAL
    );

    // Translate contours to tile coordinates
    console.log('\n--- Translating Contours to Tile Coordinates ---');
    const clippedFeatures = clipContoursToTile(
      contourFeatures,
      stitched.tileWidth,
      stitched.tileHeight,
      stitched.buffer
    );
    console.log(`Translated ${clippedFeatures.length} features\n`);

    // Encode to MVT
    console.log('--- Encoding to MVT ---');
    const mvtBuffer = encodeMVT(clippedFeatures, stitched.tileWidth, stitched.tileHeight, TEST_Z, TEST_X, TEST_Y);
    console.log(`✓ MVT encoded: ${mvtBuffer.length} bytes\n`);

    // Validate MVT
    const isValid = validateMVT(mvtBuffer);

    console.log('\n=== Test Complete ===');
    if (isValid) {
      console.log('✓ Test PASSED - MVT tile generated and validated successfully!');
      process.exit(0);
    } else {
      console.log('✗ Test FAILED - MVT validation errors detected');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n✗ Test failed with error:', error);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await fileSource.close();
  }
}

// Run the test
testSingleTile();
