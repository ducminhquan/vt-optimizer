// @flow
/*eslint camelcase: ["error", {allow: ["zoom_level", "tile_row", "tile_column"]}]*/
"use strict";

const Listr = require("Listr");
const { Observable } = require("rxjs");
const IO = require("./IO");
const Log = require("./Log");
const MapboxStyle = require("./MapboxStyle");
const UI = require("../UI");
const Utils = require("./Utils");
const VTReader = require("./VTReader");
const VTWriter = require("./VTWriter");

class VTProcessor {

	static showInfo(filename) {

		const reader = new VTReader(filename);

		const tasks = [
			{title: "Parsing VT file contents", task: () => reader.open()}
		];

		const taskRunner = new Listr(tasks);
		taskRunner.run().then(
			async () => {
				
				const {vtSummary, tiles} = await VTProcessor.logInfo(reader);
				UI.printMetadata(reader.metadata.minzoom, reader.metadata.mazoom, reader.metadata.format, 
					reader.metadata.center, reader.layers);
				VTProcessor.infoLoop(reader, vtSummary, tiles);
				
			},
			err => Log.error(err)
		);

	}

	static async infoLoop(reader, vtSummary, tiles) {
	

		UI.printSummaryTable(vtSummary, tiles, VTProcessor.avgTileSizeLimit, VTProcessor.avgTileSizeWarning);

		while(await UI.wantMoreInfoQuestion()) {

			const selectedLevel = await UI.selectLevelPrompt(vtSummary);
			const {data, buckets} = await VTProcessor.computeLevelInfo(reader, selectedLevel);
			UI.showTileDistributionData(data);
			
			while(await UI.tilesInBucketQuestion()) {

				const selectedBucket = await UI.selectBucketPrompt(data);
				UI.showBucketInfo(buckets[selectedBucket]);

				UI.showTileDistributionData(data);
			}

			UI.printSummaryTable(vtSummary, tiles);

		}
		
	}

	static async logInfo(reader) {

		if (!reader.isOpen) {

			Log.error("VTProcessor::showInfo() ", "VTReader not open");

		}

		try {

			const vtSummary = await reader.getVTSummary();
			const tiles = await reader.getTooBigTilesNumber();
			return {vtSummary, tiles};

		} catch (err) {

			Log.error(err)

		}

	}

	static async computeLevelInfo(reader, zoomLevel) {

		const levelTiles = await reader.getLevelTiles(zoomLevel);
		levelTiles.sort((a, b) => a.size - b.size);

		const buckets = [];
		const data = [];
		let tiles = [];
		const numBuckets = 10;
		let minSize = levelTiles[0].size;
		const maxSize = levelTiles[levelTiles.length - 1].size;
		const totalSize = levelTiles.reduce((accum, elem) => accum + elem.size, 0);
		const totalNumTiles = levelTiles.length;
		const bucketSize = (maxSize - minSize)/numBuckets;
		let currentBucketMaxSize = minSize + bucketSize;
					

		for(let i=0; i<totalNumTiles; ++i) {

			if(levelTiles[i].size<=currentBucketMaxSize) {

				tiles.push(levelTiles[i]);

			} else {

				VTProcessor.addTilesToBucket(minSize, currentBucketMaxSize, totalNumTiles, 
					totalSize, tiles, buckets, data);

				tiles = [levelTiles[i]];
				minSize = currentBucketMaxSize;
				currentBucketMaxSize += bucketSize;

			}

		}

		VTProcessor.addTilesToBucket(minSize, currentBucketMaxSize, totalNumTiles, 
			totalSize, tiles, buckets, data);

		return {data, buckets};

	}

	static addTilesToBucket(minSize, maxSize, totalNumTiles, totalSize, tiles, buckets, data) {

		const currentBucketSize = tiles.reduce((accum, elem) => accum + elem.size, 0);
		const currentPc = (tiles.length/totalNumTiles)*100.0;
		let accumPc = 0;
		let accumBSPc = 0;

		if(data.length !== 0) {

			accumPc = data[data.length-1][4];	// Restore previous accumulated %
			accumBSPc = data[data.length-1][5];	// Restore previous accumulated bucket size %

		}

		
		accumPc += currentPc;
		accumBSPc += (currentBucketSize/totalSize)*100.0;

		data.push([minSize, maxSize, tiles.length, currentPc, accumPc, accumBSPc]);
		buckets.push(tiles);

	}

	static slim(inputFile, styleFile, outputFile) {

		const outputFileName = outputFile || `${inputFile.slice(0, -8)}_out.mbtiles`;
		const reader = new VTReader(inputFile);
		const style = new MapboxStyle(styleFile);
		const writer = new VTWriter(outputFileName);

		const tasks = [
			{
				title: "Parsing VT file contents",
				task: () => reader.open(true)
			},
			{
				title: "Parsing the style file",
				task: () => style.open()
			},
			{
				title: "Processing tiles",
				task: (ctx) => {

					return new Observable(observer => {

						VTProcessor.slimVT(reader, style, observer).then((data) => {

							ctx.newVTData = data.newVTData;
							ctx.removedLayers = data.removedLayers;
							observer.complete();

						});

					});

				}
			},
			{
				title: `Writing output file to ${outputFileName}`,
				task: (ctx) => {

					return new Promise(async (resolve, reject) => {

						IO.copyFileSync(inputFile, outputFileName);

						try {

							await writer.open();
							await writer.write(ctx.newVTData);
							resolve();

						} catch (error) {

							IO.deleteFileSync(outputFileName);
							Log.error(error);
							reject();

						}

					});

				}
			}
		];

		const taskRunner = new Listr(tasks);
		taskRunner.run().then(ctx => UI.printSlimProcessResults(ctx.removedLayers)).catch(err => {

			Log.error(err);

		});

	}

	static slimVT(reader, styleParser, observer) {

		const newVTData = [];
		const removedLayers = { perLevel: {}, perLayerName: {}};

		return new Promise((resolve) => {

			reader.getTiles().then(async (indexes) => {

				let lastLevelProcessed = Infinity;

				await Utils.asyncForEach(indexes, async (tileIndex, loopIndex) => {

					await reader.getTileData(tileIndex.zoom_level, tileIndex.tile_column, tileIndex.tile_row).then(data => {

						VTProcessor.addTileLayersIfVisible(styleParser, data, tileIndex, newVTData, removedLayers);

						if (tileIndex.zoom_level !== lastLevelProcessed || (loopIndex % 100 === 0)) {

							observer.next(`Processing level ${tileIndex.zoom_level} tiles. Current progress: ${((loopIndex / indexes.length) * 100.0).toFixed(4)}%`);
							lastLevelProcessed = tileIndex.zoom_level;

						}

					});

				});

				observer.complete();
				resolve({newVTData, removedLayers});

			});

		});

	}

	static addTileLayersIfVisible(styleParser, tileData, tileIndex, newVTData, removedLayers) {

		const newVTLayers = [];
		const layers = Object.keys(tileData.layers);

		for (const index of layers) {

			const layer = tileData.layers[index];
			if (styleParser.isLayerVisibleOnLevel(layer.name, tileIndex.zoom_level)) {

				newVTLayers.push(layer);

			} else {

				VTProcessor.addLayerToRemovedLayers(tileIndex.zoom_level, layer, removedLayers);
				tileData.layers[index] = null;	// Free the memory allocated to this layer as we won't need it anymore

			}

		}

		newVTData.push({
			zoom_level : tileIndex.zoom_level,
			tile_column : tileIndex.tile_column,
			tile_row : tileIndex.tile_row,
			layers : newVTLayers
		});

	}

	static addLayerToRemovedLayers(zoomLevel, layer, layerSet) {

		if (!layerSet.perLevel.hasOwnProperty(zoomLevel)) {

			layerSet.perLevel[zoomLevel] = 0;

		}

		layerSet.perLevel[zoomLevel] += layer.features.length;

		if (!layerSet.perLayerName.hasOwnProperty(layer.name)) {

			layerSet.perLayerName[layer.name] = new Set();

		}

		layerSet.perLayerName[layer.name].add(zoomLevel);

	}

}

VTProcessor.avgTileSizeWarning = 45;
VTProcessor.avgTileSizeLimit = 50;

module.exports = VTProcessor;