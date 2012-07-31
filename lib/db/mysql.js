/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* This is a mysql driver for the browserid server.  It maps the data
 * storage requirements of browserid onto a relational schema.  This
 * driver is intended to be fast and scalable.
 */

/*
 * The Schema:
 *                                      +--- email -------+
 *    +--- user -----------------+      |*int    id       |
 *    |*int    id                |<-----|*int    user     |
 *    | string passwd            |      |*string address  |
 *    | int    lastPasswordReset |      | enum   type     |
 *    +--------------------------+      | bool   verified |
 *                                      +-----------------+
 *
 *
 *    +------ staged ----------+
 *    |*int id                 |
 *    |*string secret          |
 *    | bool new_acct          |
 *    | int existing_user      |
 *    |*string email           |
 *    |*string passwd          |
 *    | timestamp ts           |
 *    +------------------------+
 */

/*global dne:true */

const
mysql = require('./mysql_wrapper.js'),
secrets = require('../secrets.js'),
logger = require('../logging.js').logger,
conf = require('../configuration.js');

var client = undefined;

// for testing!  when 'STALL_MYSQL_WHEN_PRESENT' is defined in the environment,
// it causes the driver to simulate stalling whent said file is present
if (conf.get('env') === 'test_mysql' && process.env['STALL_MYSQL_WHEN_PRESENT']) {
  logger.debug('database driver will be stalled when file is present: ' +
               process.env['STALL_MYSQL_WHEN_PRESENT']);
  const fs = require('fs');
  fs.watchFile(
    process.env['STALL_MYSQL_WHEN_PRESENT'],
    { persistent: false, interval: 1 },
    function (curr, prev) {
      // stall the database driver when specified file is present
      fs.stat(process.env['STALL_MYSQL_WHEN_PRESENT'], function(err, stats) {
        if (client) {
          var stall = !(err && err.code === 'ENOENT');
          logger.debug("database driver is " + (stall ? "stalled" : "unblocked"));
          client.stall(stall);
        }
      });
    });
}

// If you change these schemas, please notify <services-ops@mozilla.com>
const schemas = [
  "CREATE TABLE IF NOT EXISTS user (" +
    "id BIGINT AUTO_INCREMENT PRIMARY KEY," +
    "passwd CHAR(64)," +
    "lastPasswordReset TIMESTAMP DEFAULT 0 NOT NULL" +
    ") ENGINE=InnoDB;",

  "CREATE TABLE IF NOT EXISTS email (" +
    "id BIGINT AUTO_INCREMENT PRIMARY KEY," +
    "user BIGINT NOT NULL," +
    "address VARCHAR(255) UNIQUE NOT NULL," +
    "type ENUM('secondary', 'primary') DEFAULT 'secondary' NOT NULL," +
    "verified BOOLEAN DEFAULT TRUE NOT NULL, " +
    "FOREIGN KEY user_fkey (user) REFERENCES user(id)" +
    ") ENGINE=InnoDB;",

  "CREATE TABLE IF NOT EXISTS staged (" +
    "id BIGINT AUTO_INCREMENT PRIMARY KEY," +
    "secret CHAR(48) UNIQUE NOT NULL," +
    "new_acct BOOL NOT NULL," +
    "existing_user BIGINT," +
    "email VARCHAR(255) UNIQUE NOT NULL," +
    "passwd CHAR(64)," +
    "ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL," +
    "FOREIGN KEY existing_user_fkey (existing_user) REFERENCES user(id)" +
    ") ENGINE=InnoDB;",
];

function now() { return Math.floor(new Date().getTime() / 1000); }

// log an unexpected database error
function logUnexpectedError(detail) {
  // first, get line number of callee
  var where;
  try { dne; } catch (e) { where = e.stack.split('\n')[2].trim(); };
  // now log it!
  logger.warn("unexpected database failure: " + detail + " -- " + where);
}

// open & create the mysql database
exports.open = function(cfg, cb) {
  if (client) throw "database is already open!";
  // mysql config requires
  var options = {
    host: '127.0.0.1',
    port: "3306",
    user: undefined,
    password: undefined,
    unit_test: false
  };

  Object.keys(options).forEach(function(param) {
    options[param] = (cfg[param] !== undefined ? cfg[param] : options[param]);
    if (options[param] === undefined) delete options[param];
  });

  // let's figure out the database name
  var database = cfg.name;
  if (!database) database = "browserid";

  // create the client
  function doConnect() {
    logger.debug("connecting to database: " + database);
    options.database = database;
    client = mysql.createClient(options);
    client.ping(function(err) {
      logger.debug("connection to database " + (err ? ("fails: " + err) : "established"));
      cb(err);
    });
  }

  // now create the databse
  if (cfg.create_schema) {
    logger.debug("creating database and tables if required");
    var createClient = mysql.createClient(options);
    createClient.query("CREATE DATABASE IF NOT EXISTS " + database, function(err) {
      if (err) {
        logUnexpectedError(err);
        cb(err);
        return;
      }
      createClient.useDatabase(database, function(err) {
        if (err) {
          logUnexpectedError(err);
          cb(err);
          return;
        }

        // now create tables
        function createNextTable(i) {
          if (i < schemas.length) {
            createClient.query(schemas[i], function(err) {
              if (err) {
                logUnexpectedError(err);
                cb(err);
              } else {
                createNextTable(i+1);
              }
            });
          } else {
            createClient.end(function(err) {
              if (err) {
                logUnexpectedError(err);
                cb(err);
              } else {
                doConnect();
              }
            });
          }
        }
        createNextTable(0);
      });
    });
  } else {
    doConnect();
  }
};

exports.close = function(cb) {
  client.end(function(err) {
    client = undefined;
    if (err) logUnexpectedError(err);
    if (cb) cb(err === undefined ? null : err);
  });
};

exports.closeAndRemove = function(cb) {
  var db_to_remove = client.database;

  // don't let this happen if the name of the database is 'browserid',
  // as a sanity check
  if (db_to_remove === 'browserid') {
    throw "dropping a database named 'browserid' is not allowed";
  }

  client.query("DROP DATABASE " + db_to_remove, function(err) {
    exports.close(cb);
  });
};

exports.emailKnown = function(email, cb) {
  client.query(
    "SELECT COUNT(*) as N FROM email WHERE address = ?", [ email ],
    function(err, rows) {
      cb(err, rows && rows.length > 0 && rows[0].N > 0);
    }
  );
};

exports.userKnown = function(uid, cb) {
  client.query(
    "SELECT COUNT(*) as N FROM user WHERE id = ?", [ uid ],
    function(err, rows) {
      cb(err, rows && rows.length > 0 && rows[0].N > 0);
    }
  );
};

exports.emailType = function(email, cb) {
  client.query(
    "SELECT type FROM email WHERE address = ?", [ email ],
    function(err, rows) {
      cb(err, (rows && rows.length > 0) ? rows[0].type : undefined);
    }
  );
}

exports.emailIsVerified = function(email, cb) {
  client.query(
    "SELECT verified FROM email WHERE address = ?", [ email ],
    function(err, rows) {
      if (rows && rows.length > 0) cb(err, !!rows[0].verified);
      else cb('no such email');
    }
  );
};


exports.isStaged = function(email, cb) {
  client.query(
    "SELECT COUNT(*) as N FROM staged WHERE email = ?", [ email ],
    function(err, rows) {
      cb(err, rows && rows.length > 0 && rows[0].N > 0);
    }
  );
}

exports.lastStaged = function(email, cb) {
  client.query(
    "SELECT UNIX_TIMESTAMP(ts) as ts FROM staged WHERE email = ?", [ email ],
    function(err, rows) {
      if (err) cb(err);
      else if (!rows || rows.length === 0) cb(null);
      else cb(null, new Date(rows[0].ts * 1000));
    }
  );
};

exports.stageUser = function(email, hash, cb) {
  secrets.generate(48, function(secret) {
    // overwrite previously staged users
    client.query('INSERT INTO staged (secret, new_acct, email, passwd) VALUES(?,TRUE,?,?) ' +
                 'ON DUPLICATE KEY UPDATE secret=VALUES(secret), existing_user=NULL, new_acct=TRUE, ts=NOW()',
                 [ secret, email, hash ],
                 function(err) {
                   cb(err, err ? undefined : secret);
                 });
  });
};


exports.haveVerificationSecret = function(secret, cb) {
  client.query(
    "SELECT count(*) as n FROM staged WHERE secret = ?", [ secret ],
    function(err, rows) {
      cb(err, rows && rows.length === 1 && rows[0].n === 1);
    });
};

exports.emailForVerificationSecret = function(secret, cb) {
  client.query(
    "SELECT email, existing_user, passwd FROM staged WHERE secret = ?", [ secret ],
    function(err, rows) {
      if (err) return cb("database unavailable");

      // if the record was not found, fail out
      if (!rows || rows.length != 1) return cb("no such secret");

      cb(null, rows[0].email, rows[0].existing_user, rows[0].passwd);
    });
};

exports.authForVerificationSecret = function(secret, cb) {
  client.query(
    "SELECT existing_user, passwd FROM staged WHERE secret = ?", [ secret ],
    function(err, rows) {
      if (err) return cb("database unavailable");

      // if the record was not found, fail out
      if (!rows || rows.length != 1) return cb("no such secret");

      var o = rows[0];

      // if there is a hashed passwd in the result, we're done
      if (o.passwd) return cb(null, o.passwd, o.existing_user);

      // otherwise, let's get the passwd from the user record
      if (!o.existing_user) return cb("no password for user");

      exports.checkAuth(o.existing_user, function(err, hash) {
        cb(err, hash, o.existing_user);
      });
    });
};

exports.verificationSecretForEmail = function(email, cb) {
  client.query(
    "SELECT secret FROM staged WHERE email = ?", [ email ],
    function(err, rows) {
      cb(err, (rows && rows.length > 0) ? rows[0].secret : undefined);
    });
};

function addEmailToUser(userID, email, type, cb) {
  // issue #170 - delete any old records with the same
  // email address.  this is necessary because
  // gotVerificationSecret is invoked both for
  // forgotten password flows and for new user signups.
  client.query(
    "DELETE FROM email WHERE address = ?",
    [ email ],
    function(err, info) {
      if (err) return cb(err);
      else {
        client.query(
          "INSERT INTO email(user, address, type) VALUES(?, ?, ?)",
          [ userID, email, type ],
          function(err, info) {
            if (err) logUnexpectedError(err);
            cb(err, email, userID);
          });
      }
    });
}

function getAndDeleteRowForSecret(secret, cb) {
  client.query(
    "SELECT * FROM staged WHERE secret = ?", [ secret ],
    function(err, rows) {
      if (err) {
        logUnexpectedError(err);
        cb(err);
      } else if (rows.length === 0) {
        cb("unknown secret");
      } else {
        // delete the record
        client.query("DELETE LOW_PRIORITY FROM staged WHERE secret = ?", [ secret ]);
        cb(null, rows[0]);
      }
    });
}

exports.completeCreateUser = function(secret, cb) {
  getAndDeleteRowForSecret(secret, function(err, o) {
    if (err) return cb(err);
    
    if (!o.new_acct) return cb("this verification link is not for a new account");

    // we're creating a new account, add appropriate entries into user and email tables.
    client.query(
      "INSERT INTO user(passwd, lastPasswordReset) VALUES(?,FROM_UNIXTIME(?))",
      [ o.passwd, now() ],
      function(err, info) {
        if (err) return cb(err);
        addEmailToUser(info.insertId, o.email, 'secondary', cb);
      });
  });
};

// either a email re-verification, or an email addition - we treat these things
// the same
exports.completeConfirmEmail = function(secret, cb) {
  getAndDeleteRowForSecret(secret, function(err, o) {
    if (err) return cb(err);
    
    if (o.new_acct) return cb("this verification link is not for an email addition");

    // ensure the expected existing_user field is populated, which it must always be when
    // new_acct is false
    if (typeof o.existing_user !== 'number') {
      return cb("data inconsistency, no numeric existing user associated with staged email address");
    }

    // we're adding or reverifying an email address to an existing user account.  add appropriate
    // entries into email table.
    if (o.passwd) {
      exports.updatePassword(o.existing_user, o.passwd, true, function(err) {
        if (err) return cb('could not set user\'s password');
        addEmailToUser(o.existing_user, o.email, 'secondary', cb);
      });
    } else {
      addEmailToUser(o.existing_user, o.email, 'secondary', cb);
    }
  });
};

exports.completePasswordReset = function(secret, cb) {
  getAndDeleteRowForSecret(secret, function(err, o) {
    if (err) return cb(err);
    
    if (o.new_acct || !o.passwd || !o.existing_user) {
      return cb("this verification link is not for a password reset");
    }

    // verify that the email still exists in the database, and the the user with whom it is
    // associated is the same as the user in the database
    exports.emailToUID(o.email, function(err, uid) {
      if (err) return cb(err);

      // if for some reason the email is associated with a different user now than when
      // the action was initiated, error out.
      if (uid !== o.existing_user) {
        return cb("cannot update password, data inconsistency");
      }

      // flip the verification bit on all emails for the user other than the one just verified
      client.query(
        'UPDATE email SET verified = FALSE WHERE user = ? AND type = ? AND address != ?',
        [ uid, 'secondary', o.email ],
        function(err) {
          if (err) return cb(err);
      
          // update the password!
          exports.updatePassword(uid, o.passwd, true, function(err) {
            cb(err, o.email, uid);
          });
        });
    });
  });
};

exports.addPrimaryEmailToAccount = function(uid, emailToAdd, cb) {
  // we're adding an email address to an existing user account.  add appropriate entries into
  // email table
  addEmailToUser(uid, emailToAdd, 'primary', cb);
}

exports.createUserWithPrimaryEmail = function(email, cb) {
  // create a new user acct with no password
  client.query(
    "INSERT INTO user(lastPasswordReset) VALUES(FROM_UNIXTIME(?))",
    [ now() ],
    function(err, info) {
      if (err) return cb(err);
      var uid = info.insertId;
      client.query(
        "INSERT INTO email(user, address, type) VALUES(?, ?, ?)",
        [ uid, email, 'primary' ],
        function(err, info) {
          cb(err, uid);
        });
    });
};

exports.emailsBelongToSameAccount = function(lhs, rhs, cb) {
  client.query(
    'SELECT COUNT(*) AS n FROM email WHERE address = ? AND user = ( SELECT user FROM email WHERE address = ? );',
    [ lhs, rhs ],
    function (err, rows) {
      cb(err, rows && rows.length === 1 && rows[0].n === 1);
    });
}

exports.userOwnsEmail = function(uid, email, cb) {
  client.query(
    'SELECT COUNT(*) AS n FROM email WHERE address = ? AND user = ?',
    [ email, uid ],
    function (err, rows) {
      cb(err, rows && rows.length === 1 && rows[0].n === 1);
    });
}

exports.stageEmail = function(existing_user, new_email, hash, cb) {
  secrets.generate(48, function(secret) {
    // overwrite previously staged users
    client.query('INSERT INTO staged (secret, new_acct, existing_user, email, passwd) VALUES(?,FALSE,?,?,?) ' +
                 'ON DUPLICATE KEY UPDATE secret=VALUES(secret), existing_user=VALUES(existing_user), new_acct=FALSE, ts=NOW()',
                 [ secret, existing_user, new_email, hash ],
                 function(err) {
                   cb(err, err ? undefined : secret);
                 });
  });
};

exports.emailToUID = function(email, cb) {
  client.query(
    'SELECT user FROM email WHERE address = ?',
    [ email ],
    function (err, rows) {
      cb(err, (rows && rows.length == 1) ? rows[0].user : undefined);
    });
};

exports.checkAuth = function(uid, cb) {
  client.query(
    'SELECT passwd FROM user WHERE id = ?',
    [ uid ],
    function (err, rows) {
      cb(err, (rows && rows.length == 1) ? rows[0].passwd : undefined);
    });
}

exports.lastPasswordReset = function(uid, cb) {
  client.query(
    'SELECT UNIX_TIMESTAMP(lastPasswordReset) AS lastPasswordReset FROM user WHERE id = ?',
    [ uid ],
    function (err, rows) {
      cb(err, (rows && rows.length == 1) ? rows[0].lastPasswordReset : undefined);
    });
}

exports.updatePassword = function(uid, hash, invalidateSessions, cb) {
  var query = invalidateSessions ?
    'UPDATE user SET passwd = ?, lastPasswordReset = FROM_UNIXTIME(?) WHERE id = ?' :
    'UPDATE user SET passwd = ? WHERE id = ?';
  var args = invalidateSessions ? [ hash, now(), uid ] : [ hash, uid ];
  client.query(query, args,
    function (err, rows) {
      if (!err && (!rows || rows.affectedRows !== 1)) {
        err = "no record with id " + uid;
      }
      cb(err);
    });
}

/*
 * list the user's emails.
 *
 * returns an object keyed by email address with properties for each email.
 */
exports.listEmails = function(uid, cb) {
  client.query(
    'SELECT address, type, verified FROM email WHERE user = ?',
      [ uid ],
      function (err, rows) {
        if (err) cb(err);
        else {
          var emails = {};

          for (var i = 0; i < rows.length; i++) {
            var o = { type: rows[i].type };
            if (o.type === 'secondary') {
              o.verified = rows[i].verified ? true : false;
            }
            emails[rows[i].address] = o;
          }

          cb(null,emails);
        }
      });
};

exports.removeEmail = function(authenticated_user, email, cb) {
  exports.userOwnsEmail(authenticated_user, email, function(err, ok) {
    if (err) return cb(err);

    if (!ok) {
      logger.warn(authenticated_user + ' attempted to delete an email that doesn\'t belong to her: ' + email);
      cb("authenticated user doesn't have permission to remove specified email " + email);
      return;
    }

    client.query(
      'DELETE FROM email WHERE address = ?',
      [ email ],
      function(err, info) {
        cb(err);
      });
  });
};

exports.cancelAccount = function(uid, cb) {
  client.query("DELETE LOW_PRIORITY FROM email WHERE user = ?", [ uid ], function(err) {
    if (err) return cb(err);
    client.query("DELETE LOW_PRIORITY FROM user WHERE id = ?", [ uid ], cb);
  });
};

exports.addTestUser = function(email, hash, cb) {
  client.query(
    "INSERT INTO user(passwd, lastPasswordReset) VALUES(FROM_UNIXTIME(?))",
    [ hash, now() ],
    function(err, info) {
      if (err) return cb(err);

      client.query(
        "INSERT INTO email(user, address) VALUES(?, ?)",
        [ info.insertId, email ],
        function(err, info) {
          if (err) logUnexpectedError(err);
          cb(err, err ? null : email);
        });
    });
};

exports.ping = function(cb) {
  client.ping(function(err) {
    cb(err);
  });
};
