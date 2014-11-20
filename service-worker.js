var DEFAULT_BASE_URL = './';
var DEFAULT_VERSION = 1;

var precacheUrls;
var baseUrl;
var version;
var networkCacheName = 'network:' + self.scope + ':';
var fallbackCacheName = 'fallback:' + self.scope + ':';

function importPolyFills() {
  importScripts('../cache-polyfill/dist/serviceworker-cache-polyfill.js');
}

function deserializeUrlParams(queryString) {
  // Map is a collections class which takes an Array of Arrays as a constructor argument.
  // It's different from Array.map(), which is a method that applies a function to each
  // element in an Array, returning the result as a new Array.
  // Delightfully/confusingly, we're using both here.
  return new Map(queryString.split('&').map(function(keyValuePair) {
    return keyValuePair.split('=').map(decodeURIComponent);
  }));
}

function initFromUrlParams() {
  var params = deserializeUrlParams(location.search.substring(1));

  // Allow some defaults to be overridden via URL parameters.
  baseUrl = new URL(params.has('baseUrl') ? params.get(baseUrl) : DEFAULT_BASE_URL, self.location.href).toString();
  version = params.has('version') ? params.get('version') : DEFAULT_VERSION;
  networkCacheName += version;
  fallbackCacheName += version;
  precacheUrls = params.has('precache') ? params.get('precache').split(',') : [];
}

function getNetworkCache() {
  return caches.open(networkCacheName);
}

function getFallbackCache() {
  return caches.open(fallbackCacheName);
}

function isExpired(response) {
  var cacheControl = response.headers.get('cache-control');
  var date = response.headers.get('date');
  if(date){
    var cachedDate = new Date(Date.parse(date));
    var maxAge = parseInt(cacheHeader.match(/max-age=(\d+)/) || []).pop(), 10);
  }
  return maxAge && cachedDate.getTime() + maxAge * 1000 < new Date().getTime();
}

function checkExpire(cache, request, response) {
  if(isExpired(response) {
    cache.delete(request);
    return fetchAndStore(request);
  } else {
    return new Promise(function(resolve){
      return resolve(response);
    });
  }
}

function fetchAndStore(request) {
  return fetch(request.clone()).then(function(response) {
    if (response.status >= 400) {
      return Promise.reject(new Error(response.statusText));
    }
    console.log('  fetch successful.');
    networkCache.put(request, response.clone());
    return response;
  }).catch(function() {
    console.log('  fetch failed, trying the fallback cache.');
    return getFallbackCache().then(function(fallbackCache) {
      return fallbackCache.match(request);
    });
  });
}

function addEventListeners() {
  self.addEventListener('install', function(event) {
    // Pre-cache everything in precacheUrls, and wait until that's done to complete the install.
    event.waitUntil(
      Promise.all([
        getNetworkCache(),
        getFallbackCache()
      ]).then(function(caches) {
        return caches[0].addAll(precacheUrls);
      })
    );
  });

  self.addEventListener('activate', function(event) {
    // TODO: Tidy up old caches
  });

  self.addEventListener('fetch', function(event) {
    var request = event.request;

    // Basic read-through caching.
    event.respondWith(
      getNetworkCache().then(function(networkCache) {
        return networkCache.match(request).then(function(response) {
          if (response) {
            console.log('  cache hit!');
            return checkExpire(networkCache, request, response);
          } else {
            // we didn't have it in the cache, so add it to the cache and return it
            console.log('  cache miss; attempting to fetch and cache at runtime...');
            return fetchAndStore(request);
          }
        });
      })
    );
  });

  self.addEventListener('message', function(event) {
    console.log('onmessage; data is', event.data);

    getNetworkCache().then(function(cache) {
      var url = event.data.url;
      switch (event.data.command) {
        case 'status':
          cache.match(event.data.url).then(function(response) {
            event.data.port.postMessage({
              url: url,
              cached: !!response
            });
          });
        break;

        case 'cache':
          cache.add(url).then(function() {
            event.data.port.postMessage({
              url: url,
              cached: true
            });
          });
        break;

        case 'uncache':
          cache.delete(url).then(function() {
            event.data.port.postMessage({
              url: url,
              cached: false
            });
          });
        break;

        case 'registerFallbackUrl':
          getFallbackCache().then(function(fallbackCache) {
            fetch(event.data.fallbackUrl).then(function(response) {
              fallbackCache.put(url, response);
              console.log('  cached', event.data.fallbackUrl, 'as fallback for', url);
              event.data.port.postMessage({
                url: event.data.fallbackUrl,
                cached: true
              });
            });
          });
        break;

        case 'registerFallbackData':
          getFallbackCache().then(function(fallbackCache) {
            fallbackCache.put(url, new Response(event.data.fallbackData));
          });
        break;
      }
    });
  });
}

importPolyFills();
initFromUrlParams();
addEventListeners();
