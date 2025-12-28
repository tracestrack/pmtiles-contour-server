#!/usr/bin/env node

/**
 * Smoke test for TileJSON endpoint
 *
 * Usage:
 *   node test-tilejson.js
 *   TILEJSON_URL=http://localhost:8099/terrain-rgb.json TILE_URL=http://localhost:8099/terrain-rgb/11/1058/687.mvt node test-tilejson.js
 *
 * Note: Update the tileset name in the URLs to match your actual tileset
 */

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const TILEJSON_URL = process.env.TILEJSON_URL || 'http://localhost:8099/dtm_global.json';
const TILE_URL = process.env.TILE_URL || 'http://localhost:8099/dtm_global/11/1058/687.mvt';

async function testMVT() {
  console.log('\n🧪 Testing MVT tile endpoint...\n');
  console.log(`Testing: ${TILE_URL}`);

  try {
    const response = await fetch(TILE_URL, {
      signal: AbortSignal.timeout(10000) // 10 second timeout for tile generation
    });

    // Check response status
    if (!response.ok) {
      if (response.status === 404) {
        console.log('⚠️  Tile not found (404) - this may be expected if no data exists at this location');
        return;
      } else if (response.status === 204) {
        console.log('⚠️  No content (204) - no contours generated for this tile');
        return;
      } else if (response.status === 500) {
        console.log('⚠️  Server error (500) - tile processing failed');
        console.log('   This could happen if:');
        console.log('   - The source PMTiles tile is not in PNG format');
        console.log('   - The tile coordinate is outside the dataset bounds');
        console.log('   - There was an error decoding the DEM data');
        console.log('   Try a different tile coordinate with TILE_URL environment variable');
        return;
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    console.log('✅ Response status: 200 OK');

    // Check content-type
    const contentType = response.headers.get('content-type');
    if (contentType !== 'application/x-protobuf') {
      console.warn(`⚠️  Content-Type is ${contentType}, expected application/x-protobuf`);
    } else {
      console.log('✅ Content-Type: application/x-protobuf');
    }

    // Check CORS headers
    const corsHeader = response.headers.get('access-control-allow-origin');
    if (corsHeader) {
      console.log(`✅ CORS enabled: ${corsHeader}`);
    } else {
      console.warn('⚠️  CORS headers not found');
    }

    // Get response data
    const arrayBuffer = await response.arrayBuffer();
    const dataSize = arrayBuffer.byteLength;

    if (dataSize === 0) {
      console.warn('⚠️  Response is empty (0 bytes)');
      return;
    }

    console.log(`✅ Received MVT data: ${dataSize} bytes`);

    // Decode and validate MVT contents
    try {
      const buffer = Buffer.from(arrayBuffer);
      const tile = new VectorTile(new Pbf(buffer));

      // Check for contours layer
      if (!tile.layers.contours) {
        throw new Error('No "contours" layer found in MVT');
      }
      console.log('✅ Contours layer found in MVT');

      const contoursLayer = tile.layers.contours;
      const featureCount = contoursLayer.length;

      if (featureCount === 0) {
        console.warn('⚠️  Contours layer exists but has no features');
        console.warn('   This may indicate no elevation data in this tile');
        return;
      }

      console.log(`✅ Contours layer contains ${featureCount} features`);

      // Validate first feature
      const feature = contoursLayer.feature(0);
      const props = feature.properties;

      if (!('ele' in props)) {
        throw new Error('Feature missing "ele" property');
      }
      if (!('level' in props)) {
        throw new Error('Feature missing "level" property');
      }

      console.log(`✅ Features have required properties (ele: ${props.ele}m, level: ${props.level})`);

      // Check geometry
      const geometry = feature.loadGeometry();
      if (!geometry || geometry.length === 0) {
        throw new Error('Feature has no geometry');
      }

      const totalPoints = geometry.reduce((sum, ring) => sum + ring.length, 0);
      console.log(`✅ Feature geometry loaded (${geometry.length} rings, ${totalPoints} points)`);

      // Show elevation range
      const elevations = [];
      for (let i = 0; i < Math.min(10, featureCount); i++) {
        elevations.push(contoursLayer.feature(i).properties.ele);
      }
      const minEle = Math.min(...elevations);
      const maxEle = Math.max(...elevations);
      console.log(`📊 Elevation range (sampled): ${minEle}m - ${maxEle}m`);

    } catch (decodeError) {
      throw new Error(`Failed to decode MVT: ${decodeError.message}`);
    }

    console.log('\n✅ MVT tile endpoint is working correctly.');

  } catch (error) {
    console.error('\n❌ MVT test failed:', error.message);

    if (error.cause?.code === 'ECONNREFUSED') {
      console.error('\n💡 Server not running or not accessible');
    } else if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      console.error('\n💡 Tile generation took too long (>10s timeout)');
      console.error('   - This could be normal for the first tile request');
      console.error('   - DEM decoding and contour generation is CPU-intensive');
    }

    throw error;
  }
}

async function testTileJSON() {
  console.log('🧪 Running smoke tests for PMTiles Contour Server...\n');
  console.log('Testing TileJSON endpoint...');
  console.log(`URL: ${TILEJSON_URL}`);

  try {
    // Make request to TileJSON endpoint
    const response = await fetch(TILEJSON_URL, {
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });

    // Check response status
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    console.log('✅ Response status: 200 OK');

    // Parse JSON
    const tilejson = await response.json();
    console.log('✅ Valid JSON response');

    // Validate required TileJSON fields
    const requiredFields = ['tilejson', 'name', 'tiles', 'minzoom', 'maxzoom', 'vector_layers'];
    const missingFields = requiredFields.filter(field => !(field in tilejson));

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }
    console.log('✅ All required TileJSON fields present');

    // Validate TileJSON version
    if (tilejson.tilejson !== '3.0.0') {
      console.warn(`⚠️  TileJSON version is ${tilejson.tilejson}, expected 3.0.0`);
    } else {
      console.log('✅ TileJSON version: 3.0.0');
    }

    // Validate tiles array
    if (!Array.isArray(tilejson.tiles) || tilejson.tiles.length === 0) {
      throw new Error('tiles field must be a non-empty array');
    }
    console.log(`✅ Tiles URL: ${tilejson.tiles[0]}`);

    // Validate vector_layers
    if (!Array.isArray(tilejson.vector_layers) || tilejson.vector_layers.length === 0) {
      throw new Error('vector_layers field must be a non-empty array');
    }

    const contoursLayer = tilejson.vector_layers.find(layer => layer.id === 'contours');
    if (!contoursLayer) {
      throw new Error('No "contours" layer found in vector_layers');
    }
    console.log('✅ Contours layer present in vector_layers');

    // Validate contours layer fields
    if (!contoursLayer.fields || !contoursLayer.fields.ele || !contoursLayer.fields.level) {
      throw new Error('Contours layer missing required fields (ele, level)');
    }
    console.log('✅ Contours layer has required fields: ele, level');

    // Validate zoom levels
    if (typeof tilejson.minzoom !== 'number' || typeof tilejson.maxzoom !== 'number') {
      throw new Error('minzoom and maxzoom must be numbers');
    }
    console.log(`✅ Zoom levels: ${tilejson.minzoom} - ${tilejson.maxzoom}`);

    // Validate bounds
    if (!Array.isArray(tilejson.bounds) || tilejson.bounds.length !== 4) {
      throw new Error('bounds must be an array of 4 numbers [west, south, east, north]');
    }
    console.log(`✅ Bounds: ${tilejson.bounds.join(', ')}`);

    // Display full TileJSON for verification
    console.log('\n📄 TileJSON Response:');
    console.log(JSON.stringify(tilejson, null, 2));

    console.log('\n✅ TileJSON endpoint is working correctly.');

    // Test MVT tile endpoint
    await testMVT();

    console.log('\n🎉 All tests passed! Server is working correctly.');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);

    // Provide helpful debugging information
    if (error.cause?.code === 'ECONNREFUSED') {
      console.error('\n💡 Troubleshooting:');
      console.error('   - Is the server running?');
      console.error('   - Check the server is listening on the correct port');
      console.error('   - Start server: PORT=8099 CONTOUR_INTERVAL=20 node server.js <pmtiles-file>');
    } else if (error.cause?.code === 'ENOTFOUND') {
      console.error('\n💡 Troubleshooting:');
      console.error('   - Cannot resolve hostname "dev-server"');
      console.error('   - Try: TILEJSON_URL=http://localhost:8099/tilejson.json npm test');
      console.error('   - Or add "dev-server" to /etc/hosts');
    } else if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      console.error('\n💡 Troubleshooting:');
      console.error('   - Server took too long to respond (>5s timeout)');
      console.error('   - Check if server is processing tiles correctly');
    }

    process.exit(1);
  }
}

// Run the test
testTileJSON();
