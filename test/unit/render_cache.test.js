require('../support/test_helper.js');

var   _             = require('underscore');
var assert        = require('assert');
var grainstore    = require('grainstore');
var RenderCache   = require('../../lib/windshaft/renderers/render_cache');
var MapStore   = require('../../lib/windshaft/storages/mapstore');
var MapConfig   = require('../../lib/windshaft/models/mapconfig');
var RendererFactory = require('../../lib/windshaft/renderers/renderer_factory');
var redis         = require('redis');
var step          = require('step');
var serverOptions = require('../support/server_options');

suite('render_cache', function() {
 
    var redis_client = redis.createClient(global.environment.redis.port);

    // initialize core mml_store
    var mml_store  = new grainstore.MMLStore(serverOptions.redis, serverOptions.grainstore);

    var rendererFactory = new RendererFactory({
        mapnik: {
            mmlStore: mml_store
        }
    });

    var mapConfig = MapConfig.create({
        layers: [
            {
                type: 'mapnik',
                options: {
                    sql: 'select 1 id, null::geometry the_geom',
                    cartocss: '#layer { }',
                    cartocss_version: '2.3.0'
                }
            }
        ]
    });

    var mapConfig2 = MapConfig.create({
        layers: [
            {
                type: 'mapnik',
                options: {
                    sql: 'select 2 id, null::geometry the_geom',
                    cartocss: '#layer { }',
                    cartocss_version: '2.3.0'
                }
            }
        ]
    });

    var mapStore = new MapStore({}),
        mapnikOpts;


    function makeRenderCache(opts) {
        opts = opts || { timeout: 10000 };
        return new RenderCache(opts, mml_store, mapStore, mapnikOpts, rendererFactory);
    }


    suiteSetup(function(done) {
        // Check that we start with an empty redis db
        redis_client.keys("*", function(err, matches) {
            if (err) {
                return done(err);
            }
            assert.equal(matches.length, 0);

            mapStore.save(mapConfig, function(err) {
                if (err) {
                    return done(err);
                }
                mapStore.save(mapConfig2, done);
            });
        });
    });

    test('has a cache of render objects', function(){
        var render_cache = new RenderCache({timeout: 10000}, mml_store);
        assert.ok(_.isObject(render_cache.renderers));
    });

    test('cache creation invokes renderer cache processor', function(done){
        var render_cache = makeRenderCache();
        var req = {
            params: {
                dbname: "windshaft_test",
                table: 'test_table',
                x: 4,
                y: 4,
                z: 4,
                geom_type: 'point',
                style: "#test_table{}",
                format:'png',
                style_version:'2.1.0',
                processRendererCache: function(c, r, cb) {
                    c.was_here = 1; cb();
                }
            }
        };

        render_cache.getRenderer(req, function(err, item) {
          if ( err ) { done(err); return; }
          assert.equal(item.was_here, 1);
          done();
        });
    });

    test('cache renderer creation hook can error out', function(done){
        var render_cache = makeRenderCache();
        var req = {
            params: {
                dbname: "windshaft_test",
                table: 'test_table',
                x: 4,
                y: 4,
                z: 4,
                geom_type: 'point',
                style: "#test_table{}",
                format:'png',
                style_version: '2.1.0',
                processRendererCache: function(c, r, cb) {
                    cb(new Error('no dice'));
                }
            }
        };

        render_cache.getRenderer(req, function(err/*, item*/) {
          assert.equal(err.message, "no dice");
          done();
        });
    });

    test('cache renderer hook is only called when a _new_ cache is created', function(done){
        var render_cache = makeRenderCache();
        var req = {
            params: {
                dbname: "windshaft_test",
                table: 'test_table',
                x: 4,
                y: 4,
                z: 4,
                geom_type: 'point',
                style: "#test_table{}",
                format: 'png',
                style_version:'2.1.0'
            }
        };
        req.params.processRendererCache = function(c, r, cb) {
          c.was_here = 2;
          cb();
        };

        step(
          function makeRenderer() {
            render_cache.getRenderer(req, this);
          },
          function getCached(err, item) {
            assert.ifError(err);
            assert.equal(item.was_here, 2);
            req.params.processRendererCache = function(c, r, cb) {
              c.was_here = 3;
              cb(new Error('cache hook called again'));
            };
            render_cache.getRenderer(req, this);
          },
          function checkNoHook(err, item) {
            assert.ifError(err);
            assert.equal(item.was_here, 2);
            return null;
          },
          function finish(err) {
            done(err);
          }
        );
    });

    test('cache renderer item contains cache_buster', function(done){
        var render_cache = makeRenderCache();
        var req = {
            params: {
                dbname: "windshaft_test",
                table: 'test_table',
                x: 4,
                y:4,
                z:4,
                geom_type: 'point',
                style: "#test_table{}",
                format: 'png',
                style_version: '2.1.0',
                cache_buster:6
            }
        };

        render_cache.getRenderer(req, function(err, item) {
          assert.equal(item.cache_buster, 6);
          done();
        });
    });

    /**
     * THE FOLLOWING TESTS NEED SOME DB SETUP
     * They need a database setup as below with the table test_table defined
     */

    test('can generate a tilelive object', function(done){
        var render_cache = makeRenderCache();
        var req = {
            params: {
                dbname: "windshaft_test",
                table: 'test_table',
                x: 4,
                y: 4,
                z: 4,
                geom_type: 'polygon',
                format:'png'
            }
        };

        render_cache.getRenderer(req, function(err, renderer){
            assert.ok(renderer, err);
            assert.ok(renderer.get(), err);
            assert.equal(renderer.get()._uri.query.base.split(':')[0], 'windshaft_test');
            done();
        });
    });


    test('can generate > 1 tilelive object', function(done){
        var render_cache = makeRenderCache();
        var req = {params: {dbname: "windshaft_test", token: mapConfig.id(), x: 4, y:4, z:4, format:'png' }};

        render_cache.getRenderer(req, function(err, renderer){
            assert.ok(renderer, err);
            req = {params: {dbname: "windshaft_test", token: mapConfig2.id(), x: 4, y:4, z:4, format:'png' }};
            render_cache.getRenderer(req, function(/*err, renderer2*/) {
                assert.equal(_.keys(render_cache.renderers).length, 2);
                done();
            });
        });
    });


    test('can reuse tilelive object', function(done){
        var render_cache = makeRenderCache();
        var req = {params: {dbname: "windshaft_test", token: mapConfig.id(), x: 4, y:4, z:4, format:'png' }};

        render_cache.getRenderer(req, function(err, renderer){
            assert.ok(renderer, err);
            render_cache.getRenderer(req, function(/*err, renderer*/) {
                assert.equal(_.keys(render_cache.renderers).length, 1);
                done();
            });
        });
    });

    test('can delete all tilelive objects when reset', function(done){
        var render_cache = makeRenderCache();

        var req = {params: {dbname: "windshaft_test", token: mapConfig.id(), x: 4, y:4, z:4, format:'png' }};
        render_cache.getRenderer(req, function(err, renderer){
            assert.ok(renderer, err);
            assert.equal(_.keys(render_cache.renderers).length, 1);

            var req = {params: {dbname: "windshaft_test", token: mapConfig.id(), x: 4, y:4, z:4, format: 'png',
                scale_factor: 2}};
            render_cache.getRenderer(req, function(/*err, renderer*/) {
                assert.equal(_.keys(render_cache.renderers).length, 2);
                render_cache.reset(req);
                assert.equal(_.keys(render_cache.renderers).length, 0);
                done();
            });
        });
    });


    test('can delete only related tilelive objects when reset', function(done){
        var render_cache = makeRenderCache();

        var req = {params: {dbname: "windshaft_test", token: mapConfig.id(), x: 4, y:4, z:4, format:'png' }};
        render_cache.getRenderer(req, function(err, renderer){
            assert.ok(renderer, err);
            req.params.scale_factor = 2;

            render_cache.getRenderer(req, function(/*err, renderer*/) {
                delete req.params.scale_factor;
                req.params.token = mapConfig2.id();

                render_cache.getRenderer(req, function(/*err, renderer*/) {
                    assert.equal(_.keys(render_cache.renderers).length, 3);

                    req.params.token = mapConfig.id();
                    render_cache.reset(req);

                    assert.equal(_.keys(render_cache.renderers).length, 1);

                    done();
                });
            });
        });
    });

    // See https://github.com/Vizzuality/Windshaft/issues/59
    test.skip('clears both auth and non-auth renderer caches on reset', function(done){
        var render_cache = makeRenderCache();

        var req = {params: {
            user: 'postgres',
            dbname: "windshaft_test",
            table: 'test_table',
            x: 4, y:4, z:4,
            geom_type:'polygon',
            format:'png'
        }};
        render_cache.getRenderer(req, function(err, renderer){
            assert.ok(renderer, err);
            // This is an attempt at finding a value for "dbuser" which 
            // is not the empty string but still works at connecting to
            // the database. Failure to connect would result in the
            // renderer not staying in the cache, as per
            // http://github.com/CartoDB/Windshaft/issues/171
            req.params.dbuser = process.env.PGUSER || process.env.USER;

            render_cache.getRenderer(req, function(/*err, renderer*/) {
                delete req.params.sql;
                req.params.table = 'test_table_2';

                render_cache.getRenderer(req, function(/*err, renderer*/) {
                    assert.equal(_.keys(render_cache.renderers).length, 3);

                    req.params.table = 'test_table';
                    render_cache.reset(req);

                    assert.equal(_.keys(render_cache.renderers).length, 1, _.keys(render_cache.renderers).join('\n'));

                    done();
                });
            });
        });
    });


    test('can purge all tilelive objects', function(done){
        var render_cache = makeRenderCache();

        var req = {params: {dbname: "windshaft_test", token: mapConfig.id(), x: 4, y:4, z:4, format:'png' }};

        render_cache.getRenderer(req, function(err, renderer){
            assert.ok(renderer, err);
            req.params.scale_factor = 2;

            render_cache.getRenderer(req, function(/*err, renderer*/) {
                delete req.params.scale_factor;
                req.params.token = mapConfig2.id();

                render_cache.getRenderer(req, function(/*err, renderer*/) {
                    assert.equal(_.keys(render_cache.renderers).length, 3);

                    req.params.token = mapConfig.id();
                    render_cache.purge();

                    assert.equal(_.keys(render_cache.renderers).length, 0);

                    done();
                });
            });
        });
    });

    test('automatically deletes tilelive only after timeout', function(done){
        var render_cache = makeRenderCache({timeout: 100});
        var req = {
            params: {
                dbname: "windshaft_test",
                table: 'test_table',
                x: 4,
                y: 4,
                z: 4,
                geom_type: 'polygon',
                format:'png'
            }
        };
        render_cache.getRenderer(req, function(err, renderer){
            assert.ok(renderer, err);
            assert.equal(_.keys(render_cache.renderers).length, 1);
            setTimeout(function(){assert.equal(_.keys(render_cache.renderers).length, 0); done();},200);
        });
    });

    // Remove from cache renderers erroing out
    // See https://github.com/CartoDB/Windshaft/issues/171
    test('does not keep erroring renderers in cache', function(done){
        var render_cache = makeRenderCache();
        assert.equal(_.keys(render_cache.renderers).length, 0);
        var req = {params: {dbname: "windshaft_test", table: 'nonexistant', x:4, y:4, z:4, format:'png' }};
        render_cache.getRenderer(req, function(err/*, renderer*/) {
            assert.ok(err);
            // Need next tick as the renderer is removed from
            // the cache after the callback is invoked 
            setTimeout(function() {
              err = null;
              try {
                assert.equal(_.keys(render_cache.renderers).length, 0);
              }
              catch (e) { err = e; }
              done(err);
            }, 0);
        });
    });

    test('does not keep renderers in cache for unexistent tokes', function(done) {
        var renderCache = makeRenderCache();
        assert.equal(Object.keys(renderCache.renderers).length, 0);
        var req = { params: { token: "wadus", x:4, y:4, z:4, format:'png' } };
        renderCache.getRenderer(req, function(err/*, renderer*/) {
            assert.ok(err);
            assert.equal(Object.keys(renderCache.renderers).length, 0);
            done();
        });
    });

    suiteTeardown(function(done) {
      // Flush redis cache
      // See https://github.com/Vizzuality/Windshaft/issues/24
      redis_client.flushall(done);
    });

});

