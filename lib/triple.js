var _ = require('lodash'),
	acorn = require('acorn'),
	async = require('async'),
	chalk = require('chalk'),
	constants = require('./constants'),
	fs = require('fs'),
	path = require('path'),
	readline = require('readline'),
	server = require('./server'),
	spinner = require('char-spinner'),
	titanium = require('./titanium'),
	request = require('request');

var DEFAULTS = {
	PROJECT: '_tmp',
	ID: 'triple.tmpapp'
};

var tabCompletionNS = {};

module.exports = function(opts, callback) {
	var buffer = [];

	callback = arguments[arguments.length-1];
	if (!opts || _.isFunction(opts)) {
		opts = {};
	}

	if (opts.verbose) {
		titanium.verbose = true;
	}

	var rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		completer: tabCompletion(rl)
	});

	async.series([

		// make sure we're logged in
		function(cb) {
			titanium.loggedIn(function(err, loggedIn) {
				if (err) {
					return cb('error checking status: ' + err);
				} else if (!loggedIn) {
					return cb('You must be logged in to use triple. Use `titanium login`.');
				}
				return cb();
			});
		},

		// setup titanium completion database
		function (cb) {
			titanium.sdk(function(err,sdk, version, info){
				var cacheFile = path.join(sdk.path,'triple.cache');
				if (fs.existsSync(cacheFile)) {
					return fs.readFile(cacheFile, function(err,contents){
						contents && (tabCompletionSetup(JSON.parse(contents.toString())));
						cb(err);
					});
				}
				var interval = spinner();
				fs.readFile(path.join(sdk.path,'api.jsca'), function(err,buf){
					if (err) {
						return cb('error finding api.jsca file. '+err);
					}
					var tabCompletionDB = [];
					JSON.parse(buf.toString()).types.forEach(function(entry){
						tabCompletionDB.push(entry.name);
						entry.properties && entry.properties.forEach(function(prop){
							tabCompletionDB.push(entry.name+'.'+prop.name);
						});
						entry.functions && entry.functions.forEach(function(fn){
							tabCompletionDB.push(entry.name+'.'+fn.name);
						});
					});
					fs.writeFile(cacheFile, JSON.stringify(tabCompletionDB), function(err){
						clearInterval(interval);
						tabCompletionSetup(tabCompletionDB);
						cb(err);
					});
				});
			});
		},

		// create the repl project
		function(cb) {
			if (!fs.existsSync(DEFAULTS.PROJECT)) {
				console.log('[creating app]');
				var interval = spinner();
				var createOpts = _.defaults(opts.create || {}, {
					name: DEFAULTS.PROJECT,
					id: DEFAULTS.ID
				});
				titanium.create(createOpts, function(err, results) {
					clearInterval(interval);
					cb(err, results);
				});
			} else {
				cb();
			}
		},

		// prep app
		function(cb) {
			var resources = path.join(DEFAULTS.PROJECT, 'Resources'),
				app = path.join(__dirname, '..', 'app');

			fs.readdirSync(app).forEach(function(file) {
				copy(path.join(app, file), path.join(resources, file));
			});
			copy(path.join(__dirname, 'constants.js'), path.join(resources, 'constants.js'));

			cb();
		},

		// // start up repl server
		function(cb) {
			server.on('end', function(data) {
				console.error(chalk.bold.red('error: ' + data));
				process.exit(1);
			});
			server.listen(constants.PORT, cb);
		},

		// build the repl project
		function(cb) {
			console.log('[launching app]');
			var interval = spinner();
			var buildOpts = _.defaults(opts.build || {}, {
				projectDir: DEFAULTS.PROJECT,
				platform: 'ios',
				iosVersion: '7.1',
				server: server
			});
			titanium.build(buildOpts);
			server.on('ready', function() {
				clearInterval(interval);
				cb();
			});
		},

		// attempt to load file if specified
		function(cb) {
			if (opts.args && opts.args.length) {
				load(opts.args.join(' '), rl, cb);
			}
			else {
				cb();
			}
		},

		// prompt
		function(cb) {

			// clear spinner and prompt
			process.stdout.write('\r \r');
			rl.setPrompt(constants.PROMPT);
			rl.prompt();

			rl.on('line', function(line) {
				var match;

				// skip empty lines
				if (!line) {
					rl.prompt();
					return;

				// handle triple commands
				} else if (match = line.match(/^\s*(\.\w*)\s*(.*)$/)) {
					switch(match[1].substring(1)) {
						case 'break':
							buffer = [];
							rl.setPrompt(constants.PROMPT);
							rl.prompt();
							break;
						case 'clear':
							server.emit('message', constants.CLEAR_MESSAGE);
							break;
						case 'load':
							load(match[2],rl);
							break;
						case 'exit':
							return cb();
							break;
						default:
							console.error(chalk.bold.red('invalid command "' + match[1] + '"'));
							rl.prompt();
							break;
					}

				// process code
				} else {
					try {

						// assemble code from buffer
						buffer.push(line);
						var code = buffer.join('\n');

						// validate the buffered code
						acorn.parse(code);

						// send code to server
						server.emit('message', code);

						// reset buffer and prompt
						buffer = [];
						rl.setPrompt(constants.PROMPT);
					} catch (e) {

						// prompt for multi-line statement
						rl.setPrompt(constants.CONTINUE_PROMPT);
						rl.prompt();
					}
				}

			});
			rl.on('SIGINT', function() {
				if (buffer.length) {
					buffer = [];
					console.log('\n(^C again to quit)');
					rl.setPrompt(constants.PROMPT);
					rl.prompt();
				} else {
					cb();
				}
			});
		}

	], callback);
};

function copy(src, dst) {
	fs.writeFileSync(dst, fs.readFileSync(src));
}

function sendLoadCommand(rl, location, content, delay, cb) {
	try {
		acorn.parse(content);
	}
	catch (err) {
		console.log(content);
		console.error(chalk.bold.red('error parsing "' + location + '". '+err));
		return rl.prompt();
	}

	if (delay) {
		var tasks = [];
		content.split('\n').forEach(function(line){
			line = line.trim();
			if (line) {
				tasks.push(function(next){
					setTimeout(function(){
						console.log(chalk.magenta(line));
						server.emit('message', line);
						next();
					}, delay);
				});
			}
		});
		return async.series(tasks, cb);
	}
	else {
		console.log(chalk.magenta(content));
		server.emit('message', content);
		cb && cb();
	}
}

function load(value, rl, cb) {
	var tokens = value.split(' '),
		location = tokens[0],
		delay = tokens[1] || 0;
	if (/^http(s)?:\/\//.test(location)) {
		// looks like a url, fetch it
		var interval = spinner();
		return request(location, function(err,content) {
			clearInterval(interval);
			if (err) {
				console.error(chalk.bold.red('error loading "' + location + '". '+err));
				rl.prompt();
				return;
			}
			sendLoadCommand(rl, location, content.body, delay, cb);
		});
	}
	else {
		// probably a file
		if (fs.existsSync(location)) {
			return sendLoadCommand(rl, location, fs.readFileSync(location).toString(), delay, cb);
		}
	}
	console.error(chalk.bold.red('not sure how to load "' + location + '". does it exist?'));
	rl.prompt();
	cb && cb();
}

function tabCompletionSetup(tabCompletionDB) {
	if (tabCompletionDB && tabCompletionDB.length) {
		tabCompletionDB.forEach(function(name){
			var tokens = name.split('.'),
				obj = tabCompletionNS;
			for (var c=0;c<tokens.length;c++){
				var name = tokens[c];
				var entry = obj[name];
				if (!entry) {
					obj[name] = entry = {};
				}
				obj = entry;
			}
		});
		tabCompletionDB = null;
		tabCompletionNS.Ti = tabCompletionNS.Titanium;
	}
}

function tabCompletion(rl) {
	return function(line) {

		var tokens = line.split('.'),
			obj = tabCompletionNS,
			hits = [];

		for (var c=0;c<tokens.length;c++) {
			var token = tokens[c];
			if (token) {
				var entry = obj[token];
				if (!entry) {
					hits = Object.keys(obj).filter(function(e){
						return e.indexOf(token)===0;
					});
					obj = null;
					line = token;
					break;
				}
				obj = entry;
			}
		}

		if (obj) {
			hits = Object.keys(obj);
		}

		return [hits.length ? hits : Object.keys(tabCompletionNS), line];
	};
}
