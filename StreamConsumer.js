/**
 * Copyright (c) 2012 LocalResponse Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 *
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
 * OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * User: wadeforman
 * Date: 11/29/12
 * Time: 5:19 PM
 */

"use strict";

var HttpStream = require('tenacious-http');
var EventEmitter = require('events').EventEmitter;
var Q = require('q');
var http = require('http');

var __ = function() {
    EventEmitter.call(this);
};

__.INTERACTION_TIMEOUT = 300000;

/**
 * creates an instance
 * @param client - tenacious-http client
 * @return {Object}
 */
__.create = function(headers) {

    var instance = new __();

    instance.client = HttpStream.create(
        function () {
            // don't use bind so we can patch _connect in testing
            return instance._connect(headers);
        });

    instance.subscribeListener = false;
    instance.attachedSubscribeWarningListener = false;
    instance.responseData = '';
    instance.attachedListeners = false;
    instance.streams = {};

    return instance;
};

__.prototype = Object.create(EventEmitter.prototype);

/**
 * Updates active subscriptions by unsubscribing and subscribing to streams to reflect the state of streamHashes
 *
 * @param streamHashes - array of stream hashes
 * @return {Array of promises}
 */
__.prototype.setSubscriptions = function(streamHashes) {

    var self = this;
    streamHashes = streamHashes || [];

    this._restartInteractionTimeout();

    var streamsToSubscribe = this._arrayDifference(streamHashes, Object.keys(this.streams));
    var streamsToUnsubscribe = this._arrayDifference(Object.keys(this.streams), streamHashes);

    var unsubscribedPromises = streamsToUnsubscribe.map(
        function(streamHash) {
            return self.unsubscribe(streamHash);
        }
    );

    var result = streamsToSubscribe.map(
        function(streamHash) {
            return self.subscribe(streamHash);
        }).concat(unsubscribedPromises);

    if (this.client.started() == false) {
        this._start();
    }

    return result;
};

/**
 * subscribes to a single streams.
 * @param streamHash - stream hash provided by datasift.
 * @return {promise}
 */
__.prototype.subscribe = function(streamHash) {
    var self = this;

    return this._start().then(
        function() {

            if(!self._validateHash(streamHash)) {
                return Q.reject('invalid hash: ' + streamHash);
            }
            return self._subscribeToStream(streamHash);
        }
    );
};

/**
 * unsubscribes to a already subscribed stream
 * @param hash
 * @return {promise}
 */
__.prototype.unsubscribe = function(hash) {

    if(!this.streams.hasOwnProperty(hash)) {
        return Q.reject('unknown hash: ' + hash);
    }

    var body = JSON.stringify({'action' : 'unsubscribe', 'hash' : hash});

    if (this.client.started()) {
        this.client.write(body, 'utf8');
    }

    var stream = this.streams[hash];
    stream.state = 'unsubscribed';
    delete this.streams[hash];

    return Q.resolve(stream);
};

/**
 * subscribe to a specific stream hash
 * @param hash
 * @return {promise} - promise for a stream state object
 * @private
 */
__.prototype._subscribeToStream = function(hash) {

    if(this.streams.hasOwnProperty(hash)) { //already waiting or subscribed
        return this.streams[hash].deferred.promise;
    }

    var d = Q.defer();

    this.streams[hash] = {
        deferred: d,
        state: 'pending',
        hash: hash
    };

    if (this.client.started()) {
        this.client.write(JSON.stringify({'action' : 'subscribe', 'hash' : hash}), 'utf8');
    }

    return d.promise;
};

/**
 * starts the connect
 * @return {promise}
 * @private
 */
__.prototype._start = function () {

    var self = this;

    if(!this.attachedListeners) {

        this.client.on('data', function (chunk, statusCode) {
            self._onData(chunk, statusCode);
        });

        this.client.on('end', function (statusCode){
            self.emit('warning','end event received with status code ' + statusCode);
            self._onEnd(statusCode);
        });

        this.client.on('recovered', function (reason) {
            self.emit('debug', 'recovered from ' + reason);
        });

        this.attachedListeners = true;
    }

    return this.client.start();
};

/**
 * Initiates the streaming http connection with datasift, returning a request object.
 *
 * @param username
 * @param apiKey
 * @param headers   the http request headers
 *
 * @return {ServerRequest}
 */
__.prototype._connect = function (headers) {

    var hashList = Object.keys(this.streams);
    var path = '/multi?statuses=true';

    if (hashList.length > 0) {
        path += "&hashes=" + hashList.join();
    }

    var options = {
        host: 'stream.datasift.com',
        headers: headers,
        path: path
    };

    var req = http.request(options);

    req.write('\n', 'utf8');

    return req;
};

/**
 * shuts down the http connection.  if subscribe is called again, then a new underlying http connection will be created.
 * @return {promise}
 */
__.prototype.shutdown = function () {

    this.attachedListeners = false;
    this.streams = {};
    clearTimeout(this.interactionTimeout);
    this.client.write(JSON.stringify({'action' : 'stop'}));
    return this.client.stop();
};

/**
 * onData callback which handles the data stream coming from the datasift streams.
 * @param chunk
 * @param statusCode
 * @private
 */
__.prototype._onData = function(chunk, statusCode) {
    this.responseData += chunk;
    if(chunk.indexOf('\n') >= 0) {
        var data = this.responseData.split('\n');

        this.responseData = data.pop();
        for (var i = 0; i < data.length; i++) {
            if (data[i] !== undefined) {
                var eventData;
                try {
                    eventData = JSON.parse(data[i]);
                } catch(e) {
                    this.emit('warning', 'could not parse into JSON: ' + data[i] + ' with error: ' + e.toString());  //more details
                    continue;
                }
                if (eventData) {
                    this._handleEvent(eventData);
                }
            }
        }
    }
};

/**
 * on end call back
 * @param statusCode
 * @private
 */
__.prototype._onEnd = function(statusCode) {
    //underlying connection is "recovering"
    this.responseData = '';
};

/**
 * processes the data events coming from DataSift
 * @param eventData
 * @private
 */
__.prototype._handleEvent = function (eventData) {

    var self = this;
    var matches, stream;

    if (eventData.status === 'failure') {
        if(eventData.message !== 'A stop message was received. You will now be disconnected') {
            this.client.recover().then(
                function() {
                    self._resubscribe();
                }
            );
        }
        this.emit('error', new Error(eventData.message));
    }
    else if (eventData.status === 'success') {

        matches = eventData.message.match(/successfully subscribed to hash (\S+)/i);
        if (matches) {
            stream = this.streams[matches[1]];
            if (stream) {
                stream.state = 'subscribed';
                stream.deferred.resolve(stream);
            }
        }

        this.emit(eventData.status,eventData.message, eventData);
    }
    else if (eventData.status === 'warning' ) {

        matches = eventData.message.match(/The hash (\S+) doesn't exist/i);
        if (matches) {
            stream = this.streams[matches[1]];
            if (stream) {
                stream.deferred.reject(eventData.message);
                delete this.streams[matches[1]];
            }
        }

        this.emit(eventData.status, eventData.message, eventData);
    }
    else if (eventData.data !== undefined && eventData.data.deleted === true){
        this._restartInteractionTimeout();
        this.emit('delete', eventData);
    }
    else if (eventData.tick !== undefined) {
        this._restartInteractionTimeout();
        this.emit('tick', eventData);
    }
    else if (eventData.data !== undefined && eventData.data.interaction !== undefined) {

        //if there are no interactions emitted for the INTERACTION_TIMEOUT duration,
        //then the connection is recycled, which means a new underlying http connection will be created.
        this._restartInteractionTimeout();
        this.emit('interaction', eventData);
    }
    else {
        this.emit('unknownEvent', eventData);
    }
};

/**
 * recycles the connection.  used when the driver is in an unrecoverable state.  a new underlying socket will be assigned.
 * @return {promise}
 * @private
 */
__.prototype._recycle = function() {

    var self = this;
    this.emit('debug', 'recycling connection');

    return this.client.stop().then(
        function() {
            self.client.pendingStop = false;
            return self.client.recover();
        }
    ).fail(
        function(err) {
            self.emit('error', 'failed to reconnect: ' + err);
            return Q.reject(err);
        }
    );
};

/**
 * validates the format of a stream hash
 * required to be a 32 character hex string
 * @param hash
 * @return {Boolean}
 * @private
 */
__.prototype._validateHash = function (hash) {
    return /^[a-f0-9]{32}$/i.test(hash);
};

/**
 * Takes the difference between two arrays [values1] - [values2] = [resulting array of values]
 *
 * @param array1
 * @param array2
 *
 * @return {Array}
 * @private
 */
__.prototype._arrayDifference = function(array1, array2) {

    if (array1 == undefined) {
        return [];
    }

    if (array2 == undefined) {
        return array1;
    }

    return array1.filter(function(i) {return !(array2.indexOf(i) > -1);});
};

/**
 * resets the interaction timeout
 * @private
 */
__.prototype._restartInteractionTimeout = function() {
    var self = this;
    clearTimeout(this.interactionTimeout);
    this.interactionTimeout = setTimeout(function(){
        self._recycle();
        self.emit('recycle');
    }, __.INTERACTION_TIMEOUT);
};

module.exports = __;
