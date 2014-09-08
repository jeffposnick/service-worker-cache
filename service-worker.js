var CACHE_PREFIX = 'cache-v';
var DEFAULT_BASE_URL = './';
var DEFAULT_VERSION = 1;

var precacheUrls;
var baseUrl;
var version;

// TODO: This shouldn't be here. Don't store global state which will be lost across SW restarts.
var urlToFallbackUrl = {};
var urlToFallbackData = {};

function importPolyFills() {
  importScripts('polyfills/idbCacheUtils.js');
  importScripts('polyfills/idbCachePolyfill.js');
  importScripts('polyfills/idbCacheStoragePolyfill.js');
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
  // TODO: Confirm that this is called even when this isn't the initial install. Otherwise, the
  // values should be saved to IndexedDB.
  baseUrl = new URL(params.has('baseUrl') ? params.get(baseUrl) : DEFAULT_BASE_URL, self.location.href).toString();
  version = params.has('version') ? params.get('version') : DEFAULT_VERSION;
  precacheUrls = params.has('precache') ? params.get('precache').split(',') : [];
}

function absoluteUrl(url) {
  // If url is already an absolute URL, it will just return that.
  // Otherwise, it will convert a relative URL into an absolute one by joining it with baseUrl.
  return new URL(url, baseUrl).toString();
}

function addEventListeners() {
  self.addEventListener('install', function(e) {
    // Pre-cache everything in precacheUrls, and wait until that's done to complete the install.
    e.waitUntil(cachesPf.create(CACHE_PREFIX + self.version).then(function(cache) {
      return Promise.all(precacheUrls.map(function(url) {
        return cache.add(absoluteUrl(url));
      }));
    }));
  });

  self.addEventListener('fetch', function(e) {
    var request = e.request;

    // Basic read-through caching.
    e.respondWith(
      cachesPf.match(request, CACHE_PREFIX + self.version).then(function(response) {
        console.log('  cache hit!');
        return response;
      }, function() {
        // we didn't have it in the cache, so add it to the cache and return it
        return cachesPf.get(CACHE_PREFIX + self.version).then(function(cache) {
          console.log('  cache miss; attempting to fetch and cache at runtime...');

          return cache.add(request.url).then(
            function(response) {
              console.log('  fetch successful.');
              return response;
            },
            function() {
              if (request.url in urlToFallbackUrl) {
                console.log('  fetch failed; falling back to', urlToFallbackUrl[request.url]);
                return fetch(urlToFallbackUrl[request.url]);
                // TODO: Fall back to the urlToFallbackData[request.url] if present.
              } else {
                console.log('  fetch failed; no fallback available.');
              }
            }
          );
        });
      })
    );
  });

  self.addEventListener('message', function(e) {
    console.log('onmessage; data is', e.data);

    cachesPf.get(CACHE_PREFIX + self.version).then(function(cache) {
      var url = absoluteUrl(e.data.url);
      switch (e.data.command) {
        case 'status':
          // TODO: There's clearly a much better way of doing this.
          cache.keys().then(function(requests) {
            var cached = false;
            for (var i = 0; i < requests.length && !cached; i++) {
              if (requests[i].url == url) {
                cached = true;
              }
            }

            e.data.port.postMessage({
              url: e.data.url,
              cached: cached
            });
          });
        break;

        case 'cache':
          cache.add(url).then(function() {
            e.data.port.postMessage({
              url: e.data.url,
              cached: true
            });
          });
        break;

        case 'uncache':
          cache.delete(url).then(function() {
            e.data.port.postMessage({
              url: e.data.url,
              cached: false
            });
          });
        break;

        case 'registerFallbackUrl':
          var fallbackUrl = absoluteUrl(e.data.fallbackUrl);
          cache.add(fallbackUrl).then(function() {
            urlToFallbackUrl[url] = fallbackUrl;
            console.log('  cached', fallbackUrl, 'as fallback for', url);
            e.data.port.postMessage({
              url: e.data.fallbackUrl,
              cached: true
            });
          });
        break;

        case 'registerFallbackData':
          urlToFallbackData[url] = e.data.fallbackData;
        break;
      }
    });
  });
}

importPolyFills();
initFromUrlParams();
addEventListeners();
