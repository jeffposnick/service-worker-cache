(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
self.cachesPolyfill = require('../lib/caches.js');
},{"../lib/caches.js":4}],2:[function(require,module,exports){
var cacheDB = require('./cachedb');

function Cache() {
  this._name = '';
  this._origin = '';
}

var CacheProto = Cache.prototype;

CacheProto.match = function(request, params) {
  return cacheDB.match(this._origin, this._name, request, params);
};

CacheProto.matchAll = function(request, params) {
  return cacheDB.matchAll(this._origin, this._name, request, params);
};

CacheProto.addAll = function(requests) {
  Promise.all(
    requests.map(function(request) {
      return fetch(request);
    })
  ).then(function(responses) {
    return cacheDB.put(this._origin, this._name, responses.map(function(response, i) {
      return [requests[i], response];
    }));
  }.bind(this));
};

CacheProto.add = function(request) {
  return this.addAll([request]);
};

CacheProto.put = function(request, response) {
  if (!(response instanceof Response)) {
    throw TypeError("Incorrect response type");
  }

  return cacheDB.put(this._origin, this._name, [[request, response]]);
};

CacheProto.delete = function(request, params) {
  return cacheDB.delete(this._origin, this._name, request, params);
};

CacheProto.keys = function(request, params) {
  if (request) {
    return cacheDB.matchAllRequests(this._origin, this._name, request, params);
  }
  else {
    return cacheDB.allRequests(this._origin, this._name);
  }
};

module.exports = Cache;

},{"./cachedb":3}],3:[function(require,module,exports){
var IDBHelper = require('./idbhelper');

function matchesVary(request, entryRequest, entryResponse) {
  if (!entryResponse.headers.vary) {
    return true;
  }

  var varyHeaders = entryResponse.headers.vary.toLowerCase().split(',');
  var varyHeader;
  var requestHeaders = {};

  request.headers.forEach(function(val, key) {
    requestHeaders[key.toLowerCase()] = val;
  });

  for (var i = 0; i < varyHeaders.length; i++) {
    varyHeader = varyHeaders[i].trim();

    if (varyHeader == '*') {
      continue;
    }

    if (entryRequest.headers[varyHeader] != requestHeaders[varyHeader]) {
      return false;
    }
  }
  return true;
}

function createVaryID(entryRequest, entryResponse) {
  var id = '';

  if (!entryResponse.headers.vary) {
    return id;
  }

  var varyHeaders = entryResponse.headers.vary.toLowerCase().split(',');
  var varyHeader;

  for (var i = 0; i < varyHeaders.length; i++) {
    varyHeader = varyHeaders[i].trim();

    if (varyHeader == '*') {
      continue;
    }

    id += varyHeader + ': ' + (entryRequest.headers[varyHeader] || '') + '\n';
  }

  return id;
}

function flattenHeaders(headers) {
  var returnVal = {};
  headers.forEach(function(val, key) {
    returnVal[key.toLowerCase()] = val;
  });

  // so XHR can read the result (we don't have access to this header)
  returnVal['access-control-allow-origin'] = location.origin;
  return returnVal;
}

function entryToResponse(entry) {
  var entryResponse = entry.response;
  return new Response(entryResponse.body, {
    status: entryResponse.status,
    statusText: entryResponse.statusText,
    headers: entryResponse.headers
  });
}

function responseToEntry(response, body) {
  return {
    body: body,
    status: response.status,
    statusText: response.statusText,
    headers: flattenHeaders(response.headers)
  };
}

function entryToRequest(entry) {
  var entryRequest = entry.request;
  return new Request(entryRequest.url, {
    mode: entryRequest.mode,
    headers: entryRequest.headers,
    credentials: entryRequest.headers
  });
}

function requestToEntry(request) {
  return {
    url: request.url,
    mode: request.mode,
    credentials: request.credentials,
    headers: flattenHeaders(request.headers)
  };
}

function castToRequest(request) {
  if (!(request instanceof Request)) {
    request = new Request(request);
  }
  return request;
}

function CacheDB() {
  this.db = new IDBHelper('cache-polyfill', 1, function(db, oldVersion) {
    switch (oldVersion) {
      case 0:
        var namesStore = db.createObjectStore('cacheNames', {
          keyPath: ['origin', 'name']
        });
        namesStore.createIndex('origin', ['origin', 'added']);

        var entryStore = db.createObjectStore('cacheEntries', {
          keyPath: ['origin', 'cacheName', 'request.url', 'varyID']
        });
        entryStore.createIndex('origin-cacheName', ['origin', 'cacheName', 'added']);
        entryStore.createIndex('origin-cacheName-urlNoSearch', ['origin', 'cacheName', 'requestUrlNoSearch', 'added']);
        entryStore.createIndex('origin-cacheName-url', ['origin', 'cacheName', 'request.url', 'added']);
    }
  });
}

var CacheDBProto = CacheDB.prototype;

CacheDBProto._eachCache = function(tx, origin, eachCallback, doneCallback, errorCallback) {
  IDBHelper.iterate(
    tx.objectStore('cacheNames').index('origin').openCursor(IDBKeyRange.bound([origin, 0], [origin, Infinity])),
    eachCallback, doneCallback, errorCallback
  );
};

CacheDBProto._eachMatch = function(tx, origin, cacheName, request, eachCallback, doneCallback, errorCallback, params) {
  params = params || {};

  var ignoreSearch = Boolean(params.ignoreSearch);
  var ignoreMethod = Boolean(params.ignoreMethod);
  var ignoreVary = Boolean(params.ignoreVary);
  var prefixMatch = Boolean(params.prefixMatch);

  if (!ignoreMethod &&
      request.method !== 'GET' &&
      request.method !== 'HEAD') {
    // we only store GET responses at the moment, so no match
    return Promise.resolve();
  }

  var cacheEntries = tx.objectStore('cacheEntries');
  var range;
  var index;
  var indexName = 'origin-cacheName-url';
  var urlToMatch = new URL(request.url);

  urlToMatch.hash = '';

  if (ignoreSearch) {
    urlToMatch.search = '';
    indexName += 'NoSearch';
  }

  // working around chrome bugs
  urlToMatch = urlToMatch.href.replace(/(\?|#|\?#)$/, '');

  index = cacheEntries.index(indexName);

  if (prefixMatch) {
    range = IDBKeyRange.bound([origin, cacheName, urlToMatch, 0], [origin, cacheName, urlToMatch + String.fromCharCode(65535), Infinity]);
  }
  else {
    range = IDBKeyRange.bound([origin, cacheName, urlToMatch, 0], [origin, cacheName, urlToMatch, Infinity]);
  }

  IDBHelper.iterate(index.openCursor(range), function(cursor) {
    var value = cursor.value;

    if (ignoreVary || matchesVary(request, cursor.value.request, cursor.value.response)) {
      eachCallback(cursor);
    }
    else {
      cursor.continue();
    }
  }, doneCallback, errorCallback);
};

CacheDBProto._hasCache = function(tx, origin, cacheName, doneCallback, errCallback) {
  var store = tx.objectStore('cacheNames');
  return IDBHelper.callbackify(store.get([origin, cacheName]), function(val) {
    doneCallback(!!val);
  }, errCallback);
};

CacheDBProto._delete = function(tx, origin, cacheName, request, doneCallback, errCallback, params) {
  var returnVal = false;

  this._eachMatch(tx, origin, cacheName, request, function(cursor) {
    returnVal = true;
    cursor.delete();
  }, function() {
    if (doneCallback) {
      doneCallback(returnVal);
    }
  }, errCallback, params);
};

CacheDBProto.matchAllRequests = function(origin, cacheName, request, params) {
  var matches = [];

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      matches.push(cursor.key);
      cursor.continue();
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.allRequests = function(origin, cacheName) {
  var matches = [];

  return this.db.transaction('cacheEntries', function(tx) {
    var cacheEntries = tx.objectStore('cacheEntries');
    var index = cacheEntries.index('origin-cacheName');

    IDBHelper.iterate(index.openCursor(IDBKeyRange.bound([origin, cacheName, 0], [origin, cacheName, Infinity])), function(cursor) {
      matches.push(cursor.value);
      cursor.continue();
    });
  }).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.matchAll = function(origin, cacheName, request, params) {
  var matches = [];

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      matches.push(cursor.value);
      cursor.continue();
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return matches.map(entryToResponse);
  });
};

CacheDBProto.match = function(origin, cacheName, request, params) {
  var match;

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      match = cursor.value;
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return match ? entryToResponse(match) : undefined;
  });
};

CacheDBProto.matchAcrossCaches = function(origin, request, params) {
  var match;

  request = castToRequest(request);

  return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
    this._eachCache(tx, origin, function(cursor) {
      var cacheName = cursor.value.name;

      this._eachMatch(tx, origin, cacheName, request, function(cursor) {
        match = cursor.value;
        // we're done
      }, undefined, undefined, params);

      if (!match) { // continue if no match
        cursor.continue();
      }
    }.bind(this));
  }.bind(this)).then(function() {
    return match ? entryToResponse(match) : undefined;
  });
};

CacheDBProto.cacheNames = function(origin) {
  var names = [];

  return this.db.transaction('cacheNames', function(tx) {
    this._eachCache(tx, origin, function(cursor) {
      names.push(cursor.value.name);
      cursor.continue();
    }.bind(this));
  }.bind(this)).then(function() {
    return names;
  });
};

CacheDBProto.delete = function(origin, cacheName, request, params) {
  var returnVal;

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._delete(tx, origin, cacheName, request, params, function(v) {
      returnVal = v;
    });
  }.bind(this), {mode: 'readwrite'}).then(function() {
    return returnVal;
  });
};

CacheDBProto.createCache = function(origin, cacheName) {
  return this.db.transaction('cacheNames', function(tx) {
    var store = tx.objectStore('cacheNames');
    store.add({
      origin: origin,
      name: cacheName,
      added: Date.now()
    });
  }.bind(this), {mode: 'readwrite'});
};

CacheDBProto.hasCache = function(origin, cacheName) {
  var returnVal;
  return this.db.transaction('cacheNames', function(tx) {
    this._hasCache(tx, origin, cacheName, function(val) {
      returnVal = val;
    });
  }.bind(this)).then(function(val) {
    return returnVal;
  });
};

CacheDBProto.deleteCache = function(origin, cacheName) {
  var returnVal = false;

  return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
    IDBHelper.iterate(
      tx.objectStore('cacheNames').openCursor(IDBKeyRange.only([origin, cacheName])),
      del
    );

    IDBHelper.iterate(
      tx.objectStore('cacheEntries').index('origin-cacheName').openCursor(IDBKeyRange.bound([origin, cacheName, 0], [origin, cacheName, Infinity])),
      del
    );

    function del(cursor) {
      returnVal = true;
      cursor.delete();
      cursor.continue();
    }
  }.bind(this), {mode: 'readwrite'}).then(function() {
    return returnVal;
  });
};

CacheDBProto.put = function(origin, cacheName, items) {
  // items is [[request, response], [request, response], …]
  var item;

  for (var i = 0; i < items.length; i++) {
    items[i][0] = castToRequest(items[i][0]);

    if (items[i][0].method != 'GET') {
      return Promise.reject(TypeError('Only GET requests are supported'));
    }

    // ensure each entry being put won't overwrite earlier entries being put
    for (var j = 0; j < i; j++) {
      if (items[i][0].url == items[j][0].url && matchesVary(items[j][0], items[i][0], items[i][1])) {
        return Promise.reject(TypeError('Puts would overwrite eachother'));
      }
    }
  }

  return Promise.all(
    items.map(function(item) {
      return item[1].blob();
    })
  ).then(function(responseBodies) {
    return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
      this._hasCache(tx, origin, cacheName, function(hasCache) {
        if (!hasCache) {
          throw Error("Cache of that name does not exist");
        }

        items.forEach(function(item, i) {
          var request = item[0];
          var response = item[1];
          var requestEntry = requestToEntry(request);
          var responseEntry = responseToEntry(response, responseBodies[i]);

          var requestUrlNoSearch = new URL(request.url);
          requestUrlNoSearch.search = '';
          // working around Chrome bug
          requestUrlNoSearch = requestUrlNoSearch.href.replace(/\?$/, '');

          this._delete(tx, origin, cacheName, request, function() {
            tx.objectStore('cacheEntries').add({
              origin: origin,
              cacheName: cacheName,
              request: requestEntry,
              response: responseEntry,
              requestUrlNoSearch: requestUrlNoSearch,
              varyID: createVaryID(requestEntry, responseEntry),
              added: Date.now()
            });
          });

        }.bind(this));
      }.bind(this));
    }.bind(this), {mode: 'readwrite'});
  }.bind(this)).then(function() {
    return undefined;
  });
};

module.exports = new CacheDB();
},{"./idbhelper":5}],4:[function(require,module,exports){
var cacheDB = require('./cachedb');
var Cache = require('./cache');

function CacheStorage() {
  this._origin = location.origin;
}

var CacheStorageProto = CacheStorage.prototype;

CacheStorageProto._vendCache = function(name) {
  var cache = new Cache();
  cache._name = name;
  cache._origin = this._origin;
  return cache;
};

CacheStorageProto.match = function(request, params) {
  return cacheDB.matchAcrossCaches(this._origin, request, params);
};

CacheStorageProto.get = function(name) {
  return this.has(name).then(function(hasCache) {
    var cache;

    if (hasCache) {
      return this._vendCache(name);
    }
    else {
      return null;
    }
  }.bind(this));
};

CacheStorageProto.has = function(name) {
  return cacheDB.hasCache(this._origin, name);
};

CacheStorageProto.create = function(name) {
  return cacheDB.createCache(this._origin, name).then(function() {
    return this._vendCache(name);
  }.bind(this), function() {
    throw Error("Cache already exists");
  });
};

CacheStorageProto.delete = function(name) {
  return cacheDB.deleteCache(this._origin, name);
};

CacheStorageProto.keys = function() {
  return cacheDB.cacheNames(this._origin);
};

self.cachesPolyfill = module.exports = new CacheStorage();

},{"./cache":2,"./cachedb":3}],5:[function(require,module,exports){
function IDBHelper(name, version, upgradeCallback) {
  var request = indexedDB.open(name, version);
  this.ready = IDBHelper.promisify(request);
  request.onupgradeneeded = function(event) {
    upgradeCallback(request.result, event.oldVersion);
  };
}

IDBHelper.supported = 'indexedDB' in self;

IDBHelper.promisify = function(obj) {
  return new Promise(function(resolve, reject) {
    IDBHelper.callbackify(obj, resolve, reject);
  });
};

IDBHelper.callbackify = function(obj, doneCallback, errCallback) {
  function onsuccess(event) {
    if (doneCallback) {
      doneCallback(obj.result);
    }
    unlisten();
  }
  function onerror(event) {
    if (errCallback) {
      errCallback(obj.error);
    }
    unlisten();
  }
  function unlisten() {
    obj.removeEventListener('complete', onsuccess);
    obj.removeEventListener('success', onsuccess);
    obj.removeEventListener('error', onerror);
    obj.removeEventListener('abort', onerror);
  }
  obj.addEventListener('complete', onsuccess);
  obj.addEventListener('success', onsuccess);
  obj.addEventListener('error', onerror);
  obj.addEventListener('abort', onerror);
};

IDBHelper.iterate = function(cursorRequest, eachCallback, doneCallback, errorCallback) {
  var oldCursorContinue;

  function cursorContinue() {
    this._continuing = true;
    return oldCursorContinue.call(this);
  }

  cursorRequest.onsuccess = function() {
    var cursor = cursorRequest.result;

    if (!cursor) {
      if (doneCallback) {
        doneCallback();
      }
      return;
    }

    if (cursor.continue != cursorContinue) {
      oldCursorContinue = cursor.continue;
      cursor.continue = cursorContinue;
    }

    eachCallback(cursor);

    if (!cursor._continuing) {
      if (doneCallback) {
        doneCallback();
      }
    }
  };

  cursorRequest.onerror = function() {
    if (errorCallback) {
      errorCallback(cursorRequest.error);
    }
  };
};

var IDBHelperProto = IDBHelper.prototype;

IDBHelperProto.transaction = function(stores, callback, opts) {
  opts = opts || {};

  return this.ready.then(function(db) {
    var mode = opts.mode || 'readonly';

    var tx = db.transaction(stores, mode);
    callback(tx, db);
    return IDBHelper.promisify(tx);
  });
};

module.exports = IDBHelper;
},{}]},{},[1])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9jYWNoZS1wb2x5ZmlsbC9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnJvd3Nlci1wYWNrL19wcmVsdWRlLmpzIiwiLi9idWlsZC9pbmRleC5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9jYWNoZS1wb2x5ZmlsbC9saWIvY2FjaGUuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvY2FjaGUtcG9seWZpbGwvbGliL2NhY2hlZGIuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvY2FjaGUtcG9seWZpbGwvbGliL2NhY2hlcy5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9jYWNoZS1wb2x5ZmlsbC9saWIvaWRiaGVscGVyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7O0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdmFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3REQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsInNlbGYuY2FjaGVzUG9seWZpbGwgPSByZXF1aXJlKCcuLi9saWIvY2FjaGVzLmpzJyk7IiwidmFyIGNhY2hlREIgPSByZXF1aXJlKCcuL2NhY2hlZGInKTtcblxuZnVuY3Rpb24gQ2FjaGUoKSB7XG4gIHRoaXMuX25hbWUgPSAnJztcbiAgdGhpcy5fb3JpZ2luID0gJyc7XG59XG5cbnZhciBDYWNoZVByb3RvID0gQ2FjaGUucHJvdG90eXBlO1xuXG5DYWNoZVByb3RvLm1hdGNoID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLm1hdGNoKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2hBbGwodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xufTtcblxuQ2FjaGVQcm90by5hZGRBbGwgPSBmdW5jdGlvbihyZXF1ZXN0cykge1xuICBQcm9taXNlLmFsbChcbiAgICByZXF1ZXN0cy5tYXAoZnVuY3Rpb24ocmVxdWVzdCkge1xuICAgICAgcmV0dXJuIGZldGNoKHJlcXVlc3QpO1xuICAgIH0pXG4gICkudGhlbihmdW5jdGlvbihyZXNwb25zZXMpIHtcbiAgICByZXR1cm4gY2FjaGVEQi5wdXQodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXNwb25zZXMubWFwKGZ1bmN0aW9uKHJlc3BvbnNlLCBpKSB7XG4gICAgICByZXR1cm4gW3JlcXVlc3RzW2ldLCByZXNwb25zZV07XG4gICAgfSkpO1xuICB9LmJpbmQodGhpcykpO1xufTtcblxuQ2FjaGVQcm90by5hZGQgPSBmdW5jdGlvbihyZXF1ZXN0KSB7XG4gIHJldHVybiB0aGlzLmFkZEFsbChbcmVxdWVzdF0pO1xufTtcblxuQ2FjaGVQcm90by5wdXQgPSBmdW5jdGlvbihyZXF1ZXN0LCByZXNwb25zZSkge1xuICBpZiAoIShyZXNwb25zZSBpbnN0YW5jZW9mIFJlc3BvbnNlKSkge1xuICAgIHRocm93IFR5cGVFcnJvcihcIkluY29ycmVjdCByZXNwb25zZSB0eXBlXCIpO1xuICB9XG5cbiAgcmV0dXJuIGNhY2hlREIucHV0KHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgW1tyZXF1ZXN0LCByZXNwb25zZV1dKTtcbn07XG5cbkNhY2hlUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLmRlbGV0ZSh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVByb3RvLmtleXMgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgaWYgKHJlcXVlc3QpIHtcbiAgICByZXR1cm4gY2FjaGVEQi5tYXRjaEFsbFJlcXVlc3RzKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbiAgfVxuICBlbHNlIHtcbiAgICByZXR1cm4gY2FjaGVEQi5hbGxSZXF1ZXN0cyh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUpO1xuICB9XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IENhY2hlO1xuIiwidmFyIElEQkhlbHBlciA9IHJlcXVpcmUoJy4vaWRiaGVscGVyJyk7XG5cbmZ1bmN0aW9uIG1hdGNoZXNWYXJ5KHJlcXVlc3QsIGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xuICBpZiAoIWVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5KSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICB2YXIgdmFyeUhlYWRlcnMgPSBlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeS50b0xvd2VyQ2FzZSgpLnNwbGl0KCcsJyk7XG4gIHZhciB2YXJ5SGVhZGVyO1xuICB2YXIgcmVxdWVzdEhlYWRlcnMgPSB7fTtcblxuICByZXF1ZXN0LmhlYWRlcnMuZm9yRWFjaChmdW5jdGlvbih2YWwsIGtleSkge1xuICAgIHJlcXVlc3RIZWFkZXJzW2tleS50b0xvd2VyQ2FzZSgpXSA9IHZhbDtcbiAgfSk7XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XG5cbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSAhPSByZXF1ZXN0SGVhZGVyc1t2YXJ5SGVhZGVyXSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVmFyeUlEKGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xuICB2YXIgaWQgPSAnJztcblxuICBpZiAoIWVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5KSB7XG4gICAgcmV0dXJuIGlkO1xuICB9XG5cbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkudG9Mb3dlckNhc2UoKS5zcGxpdCgnLCcpO1xuICB2YXIgdmFyeUhlYWRlcjtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHZhcnlIZWFkZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyeUhlYWRlciA9IHZhcnlIZWFkZXJzW2ldLnRyaW0oKTtcblxuICAgIGlmICh2YXJ5SGVhZGVyID09ICcqJykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWQgKz0gdmFyeUhlYWRlciArICc6ICcgKyAoZW50cnlSZXF1ZXN0LmhlYWRlcnNbdmFyeUhlYWRlcl0gfHwgJycpICsgJ1xcbic7XG4gIH1cblxuICByZXR1cm4gaWQ7XG59XG5cbmZ1bmN0aW9uIGZsYXR0ZW5IZWFkZXJzKGhlYWRlcnMpIHtcbiAgdmFyIHJldHVyblZhbCA9IHt9O1xuICBoZWFkZXJzLmZvckVhY2goZnVuY3Rpb24odmFsLCBrZXkpIHtcbiAgICByZXR1cm5WYWxba2V5LnRvTG93ZXJDYXNlKCldID0gdmFsO1xuICB9KTtcblxuICAvLyBzbyBYSFIgY2FuIHJlYWQgdGhlIHJlc3VsdCAod2UgZG9uJ3QgaGF2ZSBhY2Nlc3MgdG8gdGhpcyBoZWFkZXIpXG4gIHJldHVyblZhbFsnYWNjZXNzLWNvbnRyb2wtYWxsb3ctb3JpZ2luJ10gPSBsb2NhdGlvbi5vcmlnaW47XG4gIHJldHVybiByZXR1cm5WYWw7XG59XG5cbmZ1bmN0aW9uIGVudHJ5VG9SZXNwb25zZShlbnRyeSkge1xuICB2YXIgZW50cnlSZXNwb25zZSA9IGVudHJ5LnJlc3BvbnNlO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKGVudHJ5UmVzcG9uc2UuYm9keSwge1xuICAgIHN0YXR1czogZW50cnlSZXNwb25zZS5zdGF0dXMsXG4gICAgc3RhdHVzVGV4dDogZW50cnlSZXNwb25zZS5zdGF0dXNUZXh0LFxuICAgIGhlYWRlcnM6IGVudHJ5UmVzcG9uc2UuaGVhZGVyc1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVzcG9uc2VUb0VudHJ5KHJlc3BvbnNlLCBib2R5KSB7XG4gIHJldHVybiB7XG4gICAgYm9keTogYm9keSxcbiAgICBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cyxcbiAgICBzdGF0dXNUZXh0OiByZXNwb25zZS5zdGF0dXNUZXh0LFxuICAgIGhlYWRlcnM6IGZsYXR0ZW5IZWFkZXJzKHJlc3BvbnNlLmhlYWRlcnMpXG4gIH07XG59XG5cbmZ1bmN0aW9uIGVudHJ5VG9SZXF1ZXN0KGVudHJ5KSB7XG4gIHZhciBlbnRyeVJlcXVlc3QgPSBlbnRyeS5yZXF1ZXN0O1xuICByZXR1cm4gbmV3IFJlcXVlc3QoZW50cnlSZXF1ZXN0LnVybCwge1xuICAgIG1vZGU6IGVudHJ5UmVxdWVzdC5tb2RlLFxuICAgIGhlYWRlcnM6IGVudHJ5UmVxdWVzdC5oZWFkZXJzLFxuICAgIGNyZWRlbnRpYWxzOiBlbnRyeVJlcXVlc3QuaGVhZGVyc1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVxdWVzdFRvRW50cnkocmVxdWVzdCkge1xuICByZXR1cm4ge1xuICAgIHVybDogcmVxdWVzdC51cmwsXG4gICAgbW9kZTogcmVxdWVzdC5tb2RlLFxuICAgIGNyZWRlbnRpYWxzOiByZXF1ZXN0LmNyZWRlbnRpYWxzLFxuICAgIGhlYWRlcnM6IGZsYXR0ZW5IZWFkZXJzKHJlcXVlc3QuaGVhZGVycylcbiAgfTtcbn1cblxuZnVuY3Rpb24gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KSB7XG4gIGlmICghKHJlcXVlc3QgaW5zdGFuY2VvZiBSZXF1ZXN0KSkge1xuICAgIHJlcXVlc3QgPSBuZXcgUmVxdWVzdChyZXF1ZXN0KTtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZnVuY3Rpb24gQ2FjaGVEQigpIHtcbiAgdGhpcy5kYiA9IG5ldyBJREJIZWxwZXIoJ2NhY2hlLXBvbHlmaWxsJywgMSwgZnVuY3Rpb24oZGIsIG9sZFZlcnNpb24pIHtcbiAgICBzd2l0Y2ggKG9sZFZlcnNpb24pIHtcbiAgICAgIGNhc2UgMDpcbiAgICAgICAgdmFyIG5hbWVzU3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZSgnY2FjaGVOYW1lcycsIHtcbiAgICAgICAgICBrZXlQYXRoOiBbJ29yaWdpbicsICduYW1lJ11cbiAgICAgICAgfSk7XG4gICAgICAgIG5hbWVzU3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbicsIFsnb3JpZ2luJywgJ2FkZGVkJ10pO1xuXG4gICAgICAgIHZhciBlbnRyeVN0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycsIHtcbiAgICAgICAgICBrZXlQYXRoOiBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAndmFyeUlEJ11cbiAgICAgICAgfSk7XG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAnYWRkZWQnXSk7XG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUtdXJsTm9TZWFyY2gnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdFVybE5vU2VhcmNoJywgJ2FkZGVkJ10pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lLXVybCcsIFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdyZXF1ZXN0LnVybCcsICdhZGRlZCddKTtcbiAgICB9XG4gIH0pO1xufVxuXG52YXIgQ2FjaGVEQlByb3RvID0gQ2FjaGVEQi5wcm90b3R5cGU7XG5cbkNhY2hlREJQcm90by5fZWFjaENhY2hlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spIHtcbiAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKS5pbmRleCgnb3JpZ2luJykub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCAwXSwgW29yaWdpbiwgSW5maW5pdHldKSksXG4gICAgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2tcbiAgKTtcbn07XG5cbkNhY2hlREJQcm90by5fZWFjaE1hdGNoID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaywgcGFyYW1zKSB7XG4gIHBhcmFtcyA9IHBhcmFtcyB8fCB7fTtcblxuICB2YXIgaWdub3JlU2VhcmNoID0gQm9vbGVhbihwYXJhbXMuaWdub3JlU2VhcmNoKTtcbiAgdmFyIGlnbm9yZU1ldGhvZCA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZU1ldGhvZCk7XG4gIHZhciBpZ25vcmVWYXJ5ID0gQm9vbGVhbihwYXJhbXMuaWdub3JlVmFyeSk7XG4gIHZhciBwcmVmaXhNYXRjaCA9IEJvb2xlYW4ocGFyYW1zLnByZWZpeE1hdGNoKTtcblxuICBpZiAoIWlnbm9yZU1ldGhvZCAmJlxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdHRVQnICYmXG4gICAgICByZXF1ZXN0Lm1ldGhvZCAhPT0gJ0hFQUQnKSB7XG4gICAgLy8gd2Ugb25seSBzdG9yZSBHRVQgcmVzcG9uc2VzIGF0IHRoZSBtb21lbnQsIHNvIG5vIG1hdGNoXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgdmFyIGNhY2hlRW50cmllcyA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKTtcbiAgdmFyIHJhbmdlO1xuICB2YXIgaW5kZXg7XG4gIHZhciBpbmRleE5hbWUgPSAnb3JpZ2luLWNhY2hlTmFtZS11cmwnO1xuICB2YXIgdXJsVG9NYXRjaCA9IG5ldyBVUkwocmVxdWVzdC51cmwpO1xuXG4gIHVybFRvTWF0Y2guaGFzaCA9ICcnO1xuXG4gIGlmIChpZ25vcmVTZWFyY2gpIHtcbiAgICB1cmxUb01hdGNoLnNlYXJjaCA9ICcnO1xuICAgIGluZGV4TmFtZSArPSAnTm9TZWFyY2gnO1xuICB9XG5cbiAgLy8gd29ya2luZyBhcm91bmQgY2hyb21lIGJ1Z3NcbiAgdXJsVG9NYXRjaCA9IHVybFRvTWF0Y2guaHJlZi5yZXBsYWNlKC8oXFw/fCN8XFw/IykkLywgJycpO1xuXG4gIGluZGV4ID0gY2FjaGVFbnRyaWVzLmluZGV4KGluZGV4TmFtZSk7XG5cbiAgaWYgKHByZWZpeE1hdGNoKSB7XG4gICAgcmFuZ2UgPSBJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2ggKyBTdHJpbmcuZnJvbUNoYXJDb2RlKDY1NTM1KSwgSW5maW5pdHldKTtcbiAgfVxuICBlbHNlIHtcbiAgICByYW5nZSA9IElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgSW5maW5pdHldKTtcbiAgfVxuXG4gIElEQkhlbHBlci5pdGVyYXRlKGluZGV4Lm9wZW5DdXJzb3IocmFuZ2UpLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICB2YXIgdmFsdWUgPSBjdXJzb3IudmFsdWU7XG4gICAgXG4gICAgaWYgKGlnbm9yZVZhcnkgfHwgbWF0Y2hlc1ZhcnkocmVxdWVzdCwgY3Vyc29yLnZhbHVlLnJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXNwb25zZSkpIHtcbiAgICAgIGVhY2hDYWxsYmFjayhjdXJzb3IpO1xuICAgIH1cbiAgICBlbHNlIHtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH1cbiAgfSwgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKTtcbn07XG5cbkNhY2hlREJQcm90by5faGFzQ2FjaGUgPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2spIHtcbiAgdmFyIHN0b3JlID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKTtcbiAgcmV0dXJuIElEQkhlbHBlci5jYWxsYmFja2lmeShzdG9yZS5nZXQoW29yaWdpbiwgY2FjaGVOYW1lXSksIGZ1bmN0aW9uKHZhbCkge1xuICAgIGRvbmVDYWxsYmFjayghIXZhbCk7XG4gIH0sIGVyckNhbGxiYWNrKTtcbn07XG5cbkNhY2hlREJQcm90by5fZGVsZXRlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrLCBwYXJhbXMpIHtcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xuXG4gIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgIHJldHVyblZhbCA9IHRydWU7XG4gICAgY3Vyc29yLmRlbGV0ZSgpO1xuICB9LCBmdW5jdGlvbigpIHtcbiAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICBkb25lQ2FsbGJhY2socmV0dXJuVmFsKTtcbiAgICB9XG4gIH0sIGVyckNhbGxiYWNrLCBwYXJhbXMpO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoQWxsUmVxdWVzdHMgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG5cbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLmtleSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVxdWVzdCk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmFsbFJlcXVlc3RzID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIG1hdGNoZXMgPSBbXTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB2YXIgY2FjaGVFbnRyaWVzID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpO1xuICAgIHZhciBpbmRleCA9IGNhY2hlRW50cmllcy5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpO1xuXG4gICAgSURCSGVscGVyLml0ZXJhdGUoaW5kZXgub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIEluZmluaXR5XSkpLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3IudmFsdWUpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfSk7XG4gIH0pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXF1ZXN0KTtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG5cbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLnZhbHVlKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXNwb25zZSk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2g7XG5cbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaCA9IGN1cnNvci52YWx1ZTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaCA/IGVudHJ5VG9SZXNwb25zZShtYXRjaCkgOiB1bmRlZmluZWQ7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoQWNyb3NzQ2FjaGVzID0gZnVuY3Rpb24ob3JpZ2luLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoO1xuXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoQ2FjaGUodHgsIG9yaWdpbiwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICB2YXIgY2FjaGVOYW1lID0gY3Vyc29yLnZhbHVlLm5hbWU7XG5cbiAgICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgICBtYXRjaCA9IGN1cnNvci52YWx1ZTtcbiAgICAgICAgLy8gd2UncmUgZG9uZVxuICAgICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XG5cbiAgICAgIGlmICghbWF0Y2gpIHsgLy8gY29udGludWUgaWYgbm8gbWF0Y2hcbiAgICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgICB9XG4gICAgfS5iaW5kKHRoaXMpKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaCA/IGVudHJ5VG9SZXNwb25zZShtYXRjaCkgOiB1bmRlZmluZWQ7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmNhY2hlTmFtZXMgPSBmdW5jdGlvbihvcmlnaW4pIHtcbiAgdmFyIG5hbWVzID0gW107XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hDYWNoZSh0eCwgb3JpZ2luLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG5hbWVzLnB1c2goY3Vyc29yLnZhbHVlLm5hbWUpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfS5iaW5kKHRoaXMpKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBuYW1lcztcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgcmV0dXJuVmFsO1xuXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2RlbGV0ZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcywgZnVuY3Rpb24odikge1xuICAgICAgcmV0dXJuVmFsID0gdjtcbiAgICB9KTtcbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmNyZWF0ZUNhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHZhciBzdG9yZSA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJyk7XG4gICAgc3RvcmUuYWRkKHtcbiAgICAgIG9yaWdpbjogb3JpZ2luLFxuICAgICAgbmFtZTogY2FjaGVOYW1lLFxuICAgICAgYWRkZWQ6IERhdGUubm93KClcbiAgICB9KTtcbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KTtcbn07XG5cbkNhY2hlREJQcm90by5oYXNDYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XG4gIHZhciByZXR1cm5WYWw7XG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9oYXNDYWNoZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGZ1bmN0aW9uKHZhbCkge1xuICAgICAgcmV0dXJuVmFsID0gdmFsO1xuICAgIH0pO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24odmFsKSB7XG4gICAgcmV0dXJuIHJldHVyblZhbDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uZGVsZXRlQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xuICB2YXIgcmV0dXJuVmFsID0gZmFsc2U7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xuICAgIElEQkhlbHBlci5pdGVyYXRlKFxuICAgICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLm9ubHkoW29yaWdpbiwgY2FjaGVOYW1lXSkpLFxuICAgICAgZGVsXG4gICAgKTtcblxuICAgIElEQkhlbHBlci5pdGVyYXRlKFxuICAgICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpLmluZGV4KCdvcmlnaW4tY2FjaGVOYW1lJykub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIEluZmluaXR5XSkpLFxuICAgICAgZGVsXG4gICAgKTtcblxuICAgIGZ1bmN0aW9uIGRlbChjdXJzb3IpIHtcbiAgICAgIHJldHVyblZhbCA9IHRydWU7XG4gICAgICBjdXJzb3IuZGVsZXRlKCk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9XG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5wdXQgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgaXRlbXMpIHtcbiAgLy8gaXRlbXMgaXMgW1tyZXF1ZXN0LCByZXNwb25zZV0sIFtyZXF1ZXN0LCByZXNwb25zZV0sIOKApl1cbiAgdmFyIGl0ZW07XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBpdGVtcy5sZW5ndGg7IGkrKykge1xuICAgIGl0ZW1zW2ldWzBdID0gY2FzdFRvUmVxdWVzdChpdGVtc1tpXVswXSk7XG5cbiAgICBpZiAoaXRlbXNbaV1bMF0ubWV0aG9kICE9ICdHRVQnKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoVHlwZUVycm9yKCdPbmx5IEdFVCByZXF1ZXN0cyBhcmUgc3VwcG9ydGVkJykpO1xuICAgIH1cblxuICAgIC8vIGVuc3VyZSBlYWNoIGVudHJ5IGJlaW5nIHB1dCB3b24ndCBvdmVyd3JpdGUgZWFybGllciBlbnRyaWVzIGJlaW5nIHB1dFxuICAgIGZvciAodmFyIGogPSAwOyBqIDwgaTsgaisrKSB7XG4gICAgICBpZiAoaXRlbXNbaV1bMF0udXJsID09IGl0ZW1zW2pdWzBdLnVybCAmJiBtYXRjaGVzVmFyeShpdGVtc1tqXVswXSwgaXRlbXNbaV1bMF0sIGl0ZW1zW2ldWzFdKSkge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoVHlwZUVycm9yKCdQdXRzIHdvdWxkIG92ZXJ3cml0ZSBlYWNob3RoZXInKSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgIGl0ZW1zLm1hcChmdW5jdGlvbihpdGVtKSB7XG4gICAgICByZXR1cm4gaXRlbVsxXS5ibG9iKCk7XG4gICAgfSlcbiAgKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlQm9kaWVzKSB7XG4gICAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xuICAgICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbihoYXNDYWNoZSkge1xuICAgICAgICBpZiAoIWhhc0NhY2hlKSB7XG4gICAgICAgICAgdGhyb3cgRXJyb3IoXCJDYWNoZSBvZiB0aGF0IG5hbWUgZG9lcyBub3QgZXhpc3RcIik7XG4gICAgICAgIH1cblxuICAgICAgICBpdGVtcy5mb3JFYWNoKGZ1bmN0aW9uKGl0ZW0sIGkpIHtcbiAgICAgICAgICB2YXIgcmVxdWVzdCA9IGl0ZW1bMF07XG4gICAgICAgICAgdmFyIHJlc3BvbnNlID0gaXRlbVsxXTtcbiAgICAgICAgICB2YXIgcmVxdWVzdEVudHJ5ID0gcmVxdWVzdFRvRW50cnkocmVxdWVzdCk7XG4gICAgICAgICAgdmFyIHJlc3BvbnNlRW50cnkgPSByZXNwb25zZVRvRW50cnkocmVzcG9uc2UsIHJlc3BvbnNlQm9kaWVzW2ldKTtcblxuICAgICAgICAgIHZhciByZXF1ZXN0VXJsTm9TZWFyY2ggPSBuZXcgVVJMKHJlcXVlc3QudXJsKTtcbiAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2guc2VhcmNoID0gJyc7XG4gICAgICAgICAgLy8gd29ya2luZyBhcm91bmQgQ2hyb21lIGJ1Z1xuICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaCA9IHJlcXVlc3RVcmxOb1NlYXJjaC5ocmVmLnJlcGxhY2UoL1xcPyQvLCAnJyk7XG5cbiAgICAgICAgICB0aGlzLl9kZWxldGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5hZGQoe1xuICAgICAgICAgICAgICBvcmlnaW46IG9yaWdpbixcbiAgICAgICAgICAgICAgY2FjaGVOYW1lOiBjYWNoZU5hbWUsXG4gICAgICAgICAgICAgIHJlcXVlc3Q6IHJlcXVlc3RFbnRyeSxcbiAgICAgICAgICAgICAgcmVzcG9uc2U6IHJlc3BvbnNlRW50cnksXG4gICAgICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaDogcmVxdWVzdFVybE5vU2VhcmNoLFxuICAgICAgICAgICAgICB2YXJ5SUQ6IGNyZWF0ZVZhcnlJRChyZXF1ZXN0RW50cnksIHJlc3BvbnNlRW50cnkpLFxuICAgICAgICAgICAgICBhZGRlZDogRGF0ZS5ub3coKVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgfS5iaW5kKHRoaXMpKTtcbiAgICAgIH0uYmluZCh0aGlzKSk7XG4gICAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH0pO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBuZXcgQ2FjaGVEQigpOyIsInZhciBjYWNoZURCID0gcmVxdWlyZSgnLi9jYWNoZWRiJyk7XG52YXIgQ2FjaGUgPSByZXF1aXJlKCcuL2NhY2hlJyk7XG5cbmZ1bmN0aW9uIENhY2hlU3RvcmFnZSgpIHtcbiAgdGhpcy5fb3JpZ2luID0gbG9jYXRpb24ub3JpZ2luO1xufVxuXG52YXIgQ2FjaGVTdG9yYWdlUHJvdG8gPSBDYWNoZVN0b3JhZ2UucHJvdG90eXBlO1xuXG5DYWNoZVN0b3JhZ2VQcm90by5fdmVuZENhY2hlID0gZnVuY3Rpb24obmFtZSkge1xuICB2YXIgY2FjaGUgPSBuZXcgQ2FjaGUoKTtcbiAgY2FjaGUuX25hbWUgPSBuYW1lO1xuICBjYWNoZS5fb3JpZ2luID0gdGhpcy5fb3JpZ2luO1xuICByZXR1cm4gY2FjaGU7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXR1cm4gY2FjaGVEQi5tYXRjaEFjcm9zc0NhY2hlcyh0aGlzLl9vcmlnaW4sIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5nZXQgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiB0aGlzLmhhcyhuYW1lKS50aGVuKGZ1bmN0aW9uKGhhc0NhY2hlKSB7XG4gICAgdmFyIGNhY2hlO1xuICAgIFxuICAgIGlmIChoYXNDYWNoZSkge1xuICAgICAgcmV0dXJuIHRoaXMuX3ZlbmRDYWNoZShuYW1lKTtcbiAgICB9XG4gICAgZWxzZSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH0uYmluZCh0aGlzKSk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5oYXMgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiBjYWNoZURCLmhhc0NhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5jcmVhdGUgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiBjYWNoZURCLmNyZWF0ZUNhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5fdmVuZENhY2hlKG5hbWUpO1xuICB9LmJpbmQodGhpcyksIGZ1bmN0aW9uKCkge1xuICAgIHRocm93IEVycm9yKFwiQ2FjaGUgYWxyZWFkeSBleGlzdHNcIik7XG4gIH0pO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gY2FjaGVEQi5kZWxldGVDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gY2FjaGVEQi5jYWNoZU5hbWVzKHRoaXMuX29yaWdpbik7XG59O1xuXG5zZWxmLmNhY2hlc1BvbHlmaWxsID0gbW9kdWxlLmV4cG9ydHMgPSBuZXcgQ2FjaGVTdG9yYWdlKCk7XG4iLCJmdW5jdGlvbiBJREJIZWxwZXIobmFtZSwgdmVyc2lvbiwgdXBncmFkZUNhbGxiYWNrKSB7XG4gIHZhciByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4obmFtZSwgdmVyc2lvbik7XG4gIHRoaXMucmVhZHkgPSBJREJIZWxwZXIucHJvbWlzaWZ5KHJlcXVlc3QpO1xuICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gICAgdXBncmFkZUNhbGxiYWNrKHJlcXVlc3QucmVzdWx0LCBldmVudC5vbGRWZXJzaW9uKTtcbiAgfTtcbn1cblxuSURCSGVscGVyLnN1cHBvcnRlZCA9ICdpbmRleGVkREInIGluIHNlbGY7XG5cbklEQkhlbHBlci5wcm9taXNpZnkgPSBmdW5jdGlvbihvYmopIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIElEQkhlbHBlci5jYWxsYmFja2lmeShvYmosIHJlc29sdmUsIHJlamVjdCk7XG4gIH0pO1xufTtcblxuSURCSGVscGVyLmNhbGxiYWNraWZ5ID0gZnVuY3Rpb24ob2JqLCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrKSB7XG4gIGZ1bmN0aW9uIG9uc3VjY2VzcyhldmVudCkge1xuICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgIGRvbmVDYWxsYmFjayhvYmoucmVzdWx0KTtcbiAgICB9XG4gICAgdW5saXN0ZW4oKTtcbiAgfVxuICBmdW5jdGlvbiBvbmVycm9yKGV2ZW50KSB7XG4gICAgaWYgKGVyckNhbGxiYWNrKSB7XG4gICAgICBlcnJDYWxsYmFjayhvYmouZXJyb3IpO1xuICAgIH1cbiAgICB1bmxpc3RlbigpO1xuICB9XG4gIGZ1bmN0aW9uIHVubGlzdGVuKCkge1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdjb21wbGV0ZScsIG9uc3VjY2Vzcyk7XG4gICAgb2JqLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3N1Y2Nlc3MnLCBvbnN1Y2Nlc3MpO1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uZXJyb3IpO1xuICB9XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdjb21wbGV0ZScsIG9uc3VjY2Vzcyk7XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdzdWNjZXNzJywgb25zdWNjZXNzKTtcbiAgb2JqLmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgb25lcnJvcik7XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uZXJyb3IpO1xufTtcblxuSURCSGVscGVyLml0ZXJhdGUgPSBmdW5jdGlvbihjdXJzb3JSZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaykge1xuICB2YXIgb2xkQ3Vyc29yQ29udGludWU7XG5cbiAgZnVuY3Rpb24gY3Vyc29yQ29udGludWUoKSB7XG4gICAgdGhpcy5fY29udGludWluZyA9IHRydWU7XG4gICAgcmV0dXJuIG9sZEN1cnNvckNvbnRpbnVlLmNhbGwodGhpcyk7XG4gIH1cblxuICBjdXJzb3JSZXF1ZXN0Lm9uc3VjY2VzcyA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBjdXJzb3IgPSBjdXJzb3JSZXF1ZXN0LnJlc3VsdDtcblxuICAgIGlmICghY3Vyc29yKSB7XG4gICAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICAgIGRvbmVDYWxsYmFjaygpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChjdXJzb3IuY29udGludWUgIT0gY3Vyc29yQ29udGludWUpIHtcbiAgICAgIG9sZEN1cnNvckNvbnRpbnVlID0gY3Vyc29yLmNvbnRpbnVlO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlID0gY3Vyc29yQ29udGludWU7XG4gICAgfVxuXG4gICAgZWFjaENhbGxiYWNrKGN1cnNvcik7XG5cbiAgICBpZiAoIWN1cnNvci5fY29udGludWluZykge1xuICAgICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgICBkb25lQ2FsbGJhY2soKTtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY3Vyc29yUmVxdWVzdC5vbmVycm9yID0gZnVuY3Rpb24oKSB7XG4gICAgaWYgKGVycm9yQ2FsbGJhY2spIHtcbiAgICAgIGVycm9yQ2FsbGJhY2soY3Vyc29yUmVxdWVzdC5lcnJvcik7XG4gICAgfVxuICB9O1xufTtcblxudmFyIElEQkhlbHBlclByb3RvID0gSURCSGVscGVyLnByb3RvdHlwZTtcblxuSURCSGVscGVyUHJvdG8udHJhbnNhY3Rpb24gPSBmdW5jdGlvbihzdG9yZXMsIGNhbGxiYWNrLCBvcHRzKSB7XG4gIG9wdHMgPSBvcHRzIHx8IHt9O1xuXG4gIHJldHVybiB0aGlzLnJlYWR5LnRoZW4oZnVuY3Rpb24oZGIpIHtcbiAgICB2YXIgbW9kZSA9IG9wdHMubW9kZSB8fCAncmVhZG9ubHknO1xuXG4gICAgdmFyIHR4ID0gZGIudHJhbnNhY3Rpb24oc3RvcmVzLCBtb2RlKTtcbiAgICBjYWxsYmFjayh0eCwgZGIpO1xuICAgIHJldHVybiBJREJIZWxwZXIucHJvbWlzaWZ5KHR4KTtcbiAgfSk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IElEQkhlbHBlcjsiXX0=
