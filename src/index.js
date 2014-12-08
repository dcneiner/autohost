var path = require( 'path' );
var metrics = require( 'cluster-metrics' );
var request = require( 'request' );
var when = require( 'when' );
var passportFn = require( './http/passport.js' );
var httpFn = require( './http/http.js' );
var httpAdapterFn = require( './http/adapter.js' );
var socketFn = require( './websocket/socket.js' );
var socketAdapterFn = require( './websocket/adapter.js' );
var middlewareLib = require( '../src/http/middleware.js' );
var postal = require( 'postal' );
var eventChannel = postal.channel( 'events' );
var internalFount = require( 'fount' );
var passport, httpAdapter, socketAdapter, middleware;
var initialized, api;
var wrapper = {
	 	actions: undefined,
	 	auth: undefined,
		config: undefined,
		fount: internalFount,
		init: initialize,
		metrics: metrics,
		request: request,
		meta: undefined,
		http: undefined,
		socket: undefined,
		session: middlewareLib.sessionLib,
		on: onEvent
	};

function initialize( cfg, authProvider, fount ) { //jshint ignore:line
	api = require( './api.js' )( wrapper, cfg );
	wrapper.fount = fount || internalFount;
	if( initialized ) {
		api.startAdapters();
		return when( api.resources );
	} else {
		wrapper.config = cfg;
		wrapper.stop = api.stop;
		middleware = middlewareLib( cfg, metrics );
		if( when.isPromiseLike( authProvider ) ) {
			return authProvider
				.then( function( result ) {
					wrapper.auth = result;
					return setup( result );
				} );
		} else {
			wrapper.auth = authProvider;
			return setup( authProvider );
		}
	}
}

function onEvent( topic, handle ) {
	eventChannel.subscribe( topic, handle );
}

function setup( authProvider ) { //jshint ignore:line
	var config = wrapper.config,
		metrics = wrapper.metrics;

	if( authProvider ) {
		passport = passportFn( config, authProvider, metrics );
	}

	wrapper.http = httpFn( config, request, passport, middleware, metrics );
	httpAdapter = httpAdapterFn( config, authProvider, wrapper.http, request, metrics );
	api.addAdapter( httpAdapter );

	// API metadata
	if( !config.noOptions ) {
		wrapper.http.middleware( '/api', function( req, res, next ) {
			if( req.method === 'OPTIONS' || req.method === 'options' ) {
				res.status( 200 ).send( wrapper.meta );
			} else {
				next();
			}
		} );
	}

	wrapper.socket = socketFn( config, wrapper.http, middleware );
	socketAdapter = socketAdapterFn( config, authProvider, wrapper.socket, metrics );
	api.addAdapter( socketAdapter );

	return api.start( config.resources || path.join( process.cwd(), './resource' ), authProvider )
		.then( function( meta ) {
			meta.prefix = config.apiPrefix || '/api';
			wrapper.meta = meta;
			initialized = true;
			return api.resources;
		} );
}

module.exports = wrapper;
