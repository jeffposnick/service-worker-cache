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
  importScripts('polyfills/serviceworker-cache-polyfill.js');
}

function deserializeUrlParams(queryString) {
  return JSON.parse(decodeURIComponent(queryString));
}

function initFromUrlParams() {
  var params = deserializeUrlParams(location.search.substring(1));

  // Allow some defaults to be overridden via URL parameters.
  baseUrl = new URL(params.baseUrl || DEFAULT_BASE_URL, self.location.href).toString();
  version = params.version || DEFAULT_VERSION;
  precacheUrls = params.precache || [];
}

function absoluteUrl(url) {
  // If url is already an absolute URL, it will just return that.
  // Otherwise, it will convert a relative URL into an absolute one by joining it with baseUrl.
  return new URL(url, baseUrl).toString();
}

// Take an array of promises and return a new promise that will resolve with the value of the first
// original promise that resolves. If all original promises are rejected, return a rejected promise.
function any(promises) {
  var count = promises.length;
  var errors = [];
  return new Promise(function (resolve, reject) {
    promises.forEach(function(promise) {
      promise.then(function (result) {
        resolve(result);
      }, function (error) {
        count--;
        errors.push(error);
        if (count === 0) {
          reject(errors);
        }
      });
    });
  });
};

function fetchRequest(cache, request) {
  var fetchPromise = fetch(request).then(function (response) {
    cache.put(request, response.clone());
    return response;
  }, function(error) {
    console.log('Fetch error: ', error);
    if (request.url in urlToFallbackUrl) {
      console.log('  fetch failed; falling back to', urlToFallbackUrl[request.url]);
      return fetch(urlToFallbackUrl[request.url]);
      // TODO: Fall back to the urlToFallbackData[request.url] if present.
    } else {
      console.log('  fetch failed; no fallback available.');
      throw new Error('NotFoundError');
    }
  });

  var cachePromise = cache.match(request).then(function(response) {
    if (response) {
      console.log('  cache hit!');
      return response;
    }
    throw new Error('NotFoundError');
  });

  return any([fetchPromise, cachePromise]);
}

function addEventListeners() {
  var cacheName = CACHE_PREFIX + self.version;
  var getCache = cachesPolyfill.get(cacheName);
  self.addEventListener('install', function(e) {
    // Pre-cache everything in precacheUrls, and wait until that's done to complete the install.
    e.waitUntil(
      getCache.then(function(cache) {
        return cache || cachesPolyfill.create(cacheName);
      }).then(function(cache) {
        return cache.addAll(precacheUrls.map(absoluteUrl));
      })
    );
  });

  self.addEventListener('fetch', function(e) {
    var request = e.request;

    // Basic read-through caching.
    e.respondWith(getCache.then(function (cache) {
      return fetchRequest(cache, request)
    }));
  });

  self.addEventListener('message', function(e) {
    console.log('onmessage; data is', e.data);

    getCache.then(function(cache) {
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
