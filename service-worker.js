var CACHE_PREFIX = 'cache-v';
self.version = 1;

importScripts('polyfills/idbCacheUtils.js');
importScripts('polyfills/idbCachePolyfill.js');
importScripts('polyfills/idbCacheStoragePolyfill.js');

var log = console.log.bind(console);
var err = console.error.bind(console);
self.onerror = err;

var baseUrl = (new URL('./', self.location.href) + '');
function fullUrl(relativeUrl) {
  return baseUrl + relativeUrl;
}

self.addEventListener('install', function(e) {
  var preCache = [
    // TODO: Find a way to pass in a list of URLs from the main element.
  ];
  log('oninstall; preCache is', preCache);

  e.waitUntil(caches.create(CACHE_PREFIX + self.version).then(function(cache) {
    return Promise.all(preCache.map(function(relativeUrl) {
      var url = fullUrl(relativeUrl);

      return cache.add(url).then(function() {
        log('Successfully cached', url);
      }, function(error) {
        err('Error while caching', url, error);
      });
    }));
  }));
});

self.addEventListener('fetch', function(e) {
  var request = e.request;
  log('onfetch; request URL is', request.url);

  // Basic read-through caching.
  e.respondWith(
    caches.match(request, CACHE_PREFIX + self.version).then(
      function(response) {
        log('  cache hit!');
        return response;
      },
      function() {
        // we didn't have it in the cache, so add it to the cache and return it
        return caches.get(CACHE_PREFIX + self.version).then(
          function(cache) {
            log('  cache miss; attempting to cache at runtime.');

            return cache.add(request).then(
              function(response) {
                return response;
              }
            );
          }
        );
      }
    )
  );
});

self.addEventListener('message', function(e) {
  log('onmessage; event is', e);

  caches.get(CACHE_PREFIX + self.version).then(function(cache) {
    var url = fullUrl(e.data.relativeUrl);
    switch(e.data.command) {
      case 'status':
        // TODO: There's clearly a much better way of doing this.
        cache.keys().then(function(requests) {
          var cached = false;
          for(var i = 0; i < requests.length && !cached; i++) {
            if (requests[i].url == url) {
              cached = true;
            }
          }

          e.data.port.postMessage({
            relativeUrl: e.data.relativeUrl,
            cached: cached
          });
        });
      break;

      case 'cache':
        cache.add(url).then(function() {
          e.data.port.postMessage({
            relativeUrl: e.data.relativeUrl,
            cached: true
          });
        });
      break;

      case 'uncache':
        cache.delete(url).then(function() {
          e.data.port.postMessage({
            relativeUrl: e.data.relativeUrl,
            cached: false
          });
        });
      break;
    }
  });
});