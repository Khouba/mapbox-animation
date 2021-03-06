'use strict';

var util = require('../util/util');
var Bucket = require('../data/bucket');
var FeatureIndex = require('../data/feature_index');
var vt = require('vector-tile');
var Protobuf = require('pbf');
var GeoJSONFeature = require('../util/vectortile_to_geojson');
var featureFilter = require('feature-filter');
var CollisionTile = require('../symbol/collision_tile');
var CollisionBoxArray = require('../symbol/collision_box');

module.exports = Tile;

/**
 * A tile object is the combination of a Coordinate, which defines
 * its place, as well as a unique ID and data tracking for its content
 *
 * @param {Coordinate} coord
 * @param {number} size
 * @private
 */
function Tile(coord, size, sourceMaxZoom) {
    this.coord = coord;
    this.uid = util.uniqueId();
    this.loaded = false; // TODO rename loaded
    this.isUnloaded = false;
    this.uses = 0;
    this.tileSize = size;
    this.sourceMaxZoom = sourceMaxZoom;
    this.buckets = {};
}

Tile.prototype = {

    /**
     * Given a data object with a 'buffers' property, load it into
     * this tile's elementGroups and buffers properties and set loaded
     * to true. If the data is null, like in the case of an empty
     * GeoJSON tile, no-op but still set loaded to true.
     * @param {Object} data
     * @returns {undefined}
     * @private
     */
    loadVectorData: function(data) {
        this.loaded = true;

        // empty GeoJSON tile
        if (!data) return;

        this.collisionBoxArray = new CollisionBoxArray(data.collisionBoxArray);
        this.collisionTile = new CollisionTile(data.collisionTile, this.collisionBoxArray);
        this.featureIndex = new FeatureIndex(data.featureIndex, data.rawTileData, this.collisionTile);
        this.rawTileData = data.rawTileData;
        this.buckets = unserializeBuckets(data.buckets);
    },

    /**
     * given a data object and a GL painter, destroy and re-create
     * all of its buffers.
     * @param {Object} data
     * @param {Object} painter
     * @returns {undefined}
     * @private
     */
    reloadSymbolData: function(data, painter) {
        if (this.isUnloaded) return;

        this.collisionTile = new CollisionTile(data.collisionTile, this.collisionBoxArray);
        this.featureIndex.setCollisionTile(this.collisionTile);

        // Destroy and delete existing symbol buckets
        for (var id in this.buckets) {
            var bucket = this.buckets[id];
            if (bucket.type === 'symbol') {
                bucket.destroy(painter.gl);
                delete this.buckets[id];
            }
        }

        // Add new symbol buckets
        util.extend(this.buckets, unserializeBuckets(data.buckets));
    },

    /**
     * Make sure that this tile doesn't own any data within a given
     * painter, so that it doesn't consume any memory or maintain
     * any references to the painter.
     * @param {Object} painter gl painter object
     * @returns {undefined}
     * @private
     */
    unloadVectorData: function(painter) {
        for (var id in this.buckets) {
            var bucket = this.buckets[id];
            bucket.destroy(painter.gl);
        }

        this.collisionBoxArray = null;
        this.collisionTile = null;
        this.featureIndex = null;
        this.rawTileData = null;
        this.buckets = null;
        this.loaded = false;
        this.isUnloaded = true;
    },

    redoPlacement: function(source) {
        if (!this.loaded || this.redoingPlacement) {
            this.redoWhenDone = true;
            return;
        }

        this.redoingPlacement = true;

        source.dispatcher.send('redo placement', {
            uid: this.uid,
            source: source.id,
            angle: source.map.transform.angle,
            pitch: source.map.transform.pitch,
            showCollisionBoxes: source.map.showCollisionBoxes
        }, done.bind(this), this.workerID);

        function done(_, data) {
            this.reloadSymbolData(data, source.map.painter);
            source.fire('tile.load', {tile: this});

            this.redoingPlacement = false;
            if (this.redoWhenDone) {
                this.redoPlacement(source);
                this.redoWhenDone = false;
            }
        }
    },

    getBucket: function(layer) {
        return this.buckets && this.buckets[layer.ref || layer.id];
    },

    querySourceFeatures: function(result, params) {
        if (!this.rawTileData) return;

        if (!this.vtLayers) {
            this.vtLayers = new vt.VectorTile(new Protobuf(new Uint8Array(this.rawTileData))).layers;
        }

        var layer = this.vtLayers._geojsonTileLayer || this.vtLayers[params.sourceLayer];

        if (!layer) return;

        var filter = featureFilter(params.filter);
        var coord = { z: this.coord.z, x: this.coord.x, y: this.coord.y };

        for (var i = 0; i < layer.length; i++) {
            var feature = layer.feature(i);
            if (filter(feature)) {
                var geojsonFeature = new GeoJSONFeature(feature, this.coord.z, this.coord.x, this.coord.y);
                geojsonFeature.tile = coord;
                result.push(geojsonFeature);
            }
        }
    }
};

function unserializeBuckets(input) {
    var output = {};
    for (var i = 0; i < input.length; i++) {
        var bucket = Bucket.create(input[i]);
        output[bucket.id] = bucket;
    }
    return output;
}
