var path = require( 'path' );
var _ = require( 'lodash' );
var regex = require( './regex.js' );
var log = require( '../log' )( 'autohost.http.adapter' );
var passportFn = require( './passport.js' );
var metronic = require( '../metrics' );

function buildActionUrl( state, resourceName, actionName, action, resource, resources ) {
	var prefix;
	if ( resource.apiPrefix !== undefined ) {
		// Use the resource specific override
		prefix = resource.apiPrefix;
	} else {
		// If the resource doesn't have an override, use the config or default
		prefix = state.config.apiPrefix === undefined ? 'api' : state.config.apiPrefix;
	}

	if ( _.isRegExp( action.url ) ) {
		return regex.prefix(
			state.http.buildUrl( state.config.urlPrefix || '', prefix ),
			action.url
		);
	} else if ( state.config.urlStrategy ) {
		var url = state.config.urlStrategy( resourceName, actionName, action, resources );
		prefix = hasPrefix( state, url ) ? '' : prefix;
		return state.http.buildUrl( prefix, url );
	} else {
		var resourceIndex = action.url ? action.url.indexOf( resourceName ) : -1;
		var resourcePrefix = resourceIndex === 0 || resourceIndex === 1 ? '' : resourceName;
		return state.http.buildUrl(
			prefix, resource.urlPrefix || '', resourcePrefix, ( action.url || '' )
		);
	}
}

function buildActionAlias( resourceName, actionName ) {
	return [ resourceName, actionName ].join( '.' );
}

function buildPath( pathSpec ) {
	var hasLocalPrefix;
	pathSpec = pathSpec || '';
	if ( _.isArray( pathSpec ) ) {
		hasLocalPrefix = pathSpec[ 0 ].match( /^[.]\// );
		pathSpec = path.join.apply( {}, pathSpec );
	}
	pathSpec = pathSpec.replace( /^~/, process.env.HOME );
	return hasLocalPrefix ? './' + pathSpec : pathSpec;
}

function checkPermissionFor( state, user, context, action ) {
	log.debug( 'Checking %s\'s permissions for %s',
		getUserString( user ), action
	);
	state.metrics.authorizationAttempts.record( 1, { name: 'HTTP_AUTHORIZATION_ATTEMPTS' } );
	var timer = state.metrics.authorizationTimer();
	function onError( err ) {
		log.error( 'Error during check permissions: %s', err.stack );
		state.metrics.authorizationErrors.record( 1, { name: 'HTTP_AUTHORIZATION_ERRORS' });
		timer.record( { name: 'HTTP_AUTHORIZATION_DURATION' } );
		return false;
	}
	function onPermission( granted ) {
		timer.record( { name: 'HTTP_AUTHORIZATION_DURATION' } );
		return granted;
	}
	return state.auth.checkPermission( user, action, context )
		.then( onPermission, onError );
}

function getActionMetadata( state, resource, actionName, action, meta, resources ) {
	var url = buildActionUrl( state, resource.name, actionName, action, resource, resources );
	var alias = buildActionAlias( resource.name, actionName );
	var resourceKey = [ [ resource.name, actionName ].join( '-' ), 'http' ];
	var metricKey = [ state.metrics.prefix ].concat( resourceKey );
	meta.routes[ actionName ] = { method: action.method, url: url };
	return {
		alias: alias,
		authAttempted: function() {
			state.metrics.authorizationAttempts.record( 1, { name: 'HTTP_AUTHORIZATION_ATTEMPTS' } );
		},
		authGranted: function() {
			state.metrics.authorizationGrants.record( 1, { name: 'HTTP_AUTHORIZATION_GRANTED' }  );
		},
		authRejected: function() {
			state.metrics.authorizationRejections.record( 1, { name: 'HTTP_AUTHORIZATION_REJECTED' } );
		},
		getEnvelope: function( req, res ) {
			return new state.Envelope( req, res, metricKey );
		},
		getPermissionCheck: function( req ) {
			return state.auth ? checkPermissionFor.bind( undefined, state, req.user, req.context ) : undefined;
		},
		getTimer: function() {
			return state.metrics.timer( resourceKey.concat( 'duration' ) );
		},
		handleErrors: state.config && state.config.handleRouteErrors,
		metricKey: metricKey,
		resourceKey: resourceKey,
		url: url
	};
}

function getUserString( user ) {
	return user.name || user.username || user.id || JSON.stringify( user );
}

function hasPrefix( state, url ) {
	var prefix = state.http.buildUrl(
		state.config.urlPrefix || '',
		state.config.apiPrefix || ''
	);
	return url.indexOf( prefix ) === 0;
}

function respond( state, meta, req, res, resource, action ) {
	var envelope = meta.getEnvelope( req, res );
	var result;
	if ( meta.handleErrors ) {
		try {
			result = action.handle.apply( resource, [ envelope ] );
		} catch ( err ) {
			log.error( 'API EXCEPTION! route: %s %s failed with %s',
				action.method.toUpperCase(), action.url, err.stack );
			result = err;
		}
	} else {
		result = action.handle.apply( resource, [ envelope ] );
	}
	if ( result ) {
		if ( result.then ) {
			var onResult = function onResult( x ) {
				envelope.handleReturn( state.config, resource, action, x );
			};
			result.then( onResult, onResult );
		} else {
			envelope.handleReturn( state.config, resource, action, result );
		}
	}
}

function setupPassport( config, auth ) {
	if ( auth ) {
		return passportFn( config, auth );
	}
}

function start( state ) {
	state.http.start( state.config, state.passport );
}

function stop( state ) {
	state.http.stop();
}

function wireupResource( state, resource, basePath, resources ) {
	var meta = { routes: {} };
	var static = resource.static || resource.resources;
	if ( static ) {
		static = typeof static === 'string' ? { path: static } : static;
		static.path = buildPath( [ basePath, static.path ] );
		state.http.static( '/' + resource.name, static );
		meta.path = { url: '/' + resource.name, directory: static.path };
	}
	_.each( resource.actions, function( action, actionName ) {
		wireupAction( state, resource, actionName, action, meta, resources );
	} );
	return meta;
}

function wireupAction( state, resource, actionName, action, metadata, resources ) {
	var meta = getActionMetadata( state, resource, actionName, action, metadata, resources );
	log.debug( 'Mapping resource \'%s\' action \'%s\' to %s %s',
		resource.name, actionName, action.method, meta.url );

	state.http.route( meta.url, action.method, function( req, res ) {
		req._metricKey = meta.metricKey;
		req._resource = resource.name;
		req._action = actionName;
		req._checkPermission = meta.getPermissionCheck( req );
		var timer = meta.getTimer();
		res.once( 'finish', function() {
			timer.record( { name: 'HTTP_API_DURATION' } );
		} );

		if ( state.auth ) {
			meta.authAttempted();
			checkPermissionFor( state, req.user, req.context, meta.alias )
				.then( function onPermission( pass ) {
					if ( pass ) {
						meta.authGranted();
						log.debug( 'HTTP activation of action %s (%s %s) for %j granted',
							meta.alias, action.method, meta.url, getUserString( req.user ) );
						respond( state, meta, req, res, resource, action );
					} else {
						meta.authRejected();
						log.debug( 'User %s was denied HTTP activation of action %s (%s %s)',
							getUserString( req.user ), meta.alias, action.method, meta.url );
						if ( !res._headerSent ) {
							res.status( 403 ).send( 'User lacks sufficient permissions' );
						}
					}
				} );
		} else {
			respond( state, meta, req, res, resource, action );
		}
	} );
}

module.exports = function( config, auth, http, req ) {
	var state = {
		auth: auth,
		config: config,
		http: http,
		name: 'http',
		metrics: metronic()
	};
	_.merge( state, {
		Envelope: require( './httpEnvelope.js' )( req ),
		action: wireupAction.bind( undefined, state ),
		passport: setupPassport( config, auth ),
		resource: wireupResource.bind( undefined, state ),
		start: start.bind( undefined, state ),
		stop: stop.bind( undefined, state )
	} );
	return state;
};
