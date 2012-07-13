/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const
wcli = require('../../lib/wsapi_client');

// the client "context"
var context = {};

// the configuration
var configuration = {
  browserid: 'http://127.0.0.1:10002/'
}

exports.clearCookies = function(ctx) {
  wcli.clearCookies(ctx||context);
};

exports.injectCookies = function(cookies, ctx) {
  wcli.injectCookies({cookieJar: cookies}, ctx||context);
};

exports.getCookie = function(which, ctx) {
  return wcli.getCookie(ctx||context, which);
};

exports.get = function (path, getArgs, ctx) {
  return function () {
    wcli.get(configuration, path, ctx||context, getArgs, this.callback);
  };
};

exports.post = function (path, postArgs, ctx) {
  return function () {
    wcli.post(configuration, path, ctx||context, postArgs, this.callback);
  };
};

exports.getCSRF = function(ctx) {
  var context = ctx||context;
  if (context && context.session && context.session.csrf_token) {
    return context.session.csrf_token;
  }
  return null;
};