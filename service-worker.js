var CACHE_PREFIX = 'cache-v';
// By default, use the same directory that hosts this service worker as the base URL.
var baseUrl = new URL('./', self.location.href);
self.version = '1';

function importPolyFills() {
  importScripts('polyfills/idbCacheUtils.js');
  importScripts('polyfills/idbCachePolyfill.js');
  importScripts('polyfills/idbCacheStoragePolyfill.js');
}

function queryParamValue(param) {
  var regex = new RegExp(param + '=([^&]+)');
  var match = location.search.match(regex);
  if (match) {
    return match[1];
  }
  return null;
}

function initFromUrlParams() {
  // Allow for overriding the default baseUrl via the baseUrl query parameter
  // passed as part of this service worker's URL.
  var baseUrlParam = queryParamValue('baseUrl');
  if (baseUrlParam) {
    baseUrl = new URL(baseUrlParam, self.location.href).toString();
    console.log('baseUrl', baseUrl);
  }

  var versionUrlParam = queryParamValue('version');
  if (versionUrlParam) {
    self.version = versionUrlParam;
  }
}

function absoluteUrl(url) {
  // If url is already an absolute URL, it will just return that.
  // Otherwise, it will convert a relative URL into an absolute one by joining it with baseUrl.
  return new URL(url, baseUrl).toString();
}

function addEventListeners() {
  self.addEventListener('install', function(e) {
    e.waitUntil(caches.create(CACHE_PREFIX + self.version));
  });

  self.addEventListener('fetch', function(e) {
    var request = e.request;
    console.log('onfetch; request URL is', request.url);

    // Basic read-through caching.
    e.respondWith(
      caches.match(request, CACHE_PREFIX + self.version).then(
        function(response) {
          console.log('  cache hit!');
          return response;
        },
        function() {
          // we didn't have it in the cache, so add it to the cache and return it
          return caches.get(CACHE_PREFIX + self.version).then(
            function(cache) {
              console.log('  cache miss; attempting to cache at runtime.');

              return cache.add(request).then(function(response) {
                return response;
              });
            }
          );
        }
      )
    );
  });

  self.addEventListener('message', function(e) {
    console.log('onmessage; event is', e);

    caches.get(CACHE_PREFIX + self.version).then(function(cache) {
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
      }
    });
  });
}

importPolyFills();
initFromUrlParams();
addEventListeners();