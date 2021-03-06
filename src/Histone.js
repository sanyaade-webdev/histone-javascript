/**
 * Histone.js - Histone template engine.
 * Copyright 2012 MegaFon
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

define(['./Utils', './OrderedMap', './Parser', './CallStack'],
	function(Utils, OrderedMap, Parser, CallStack) {

	var resourceCache = {};
	var URIResolver = null;
	var parserInstance = null;

	function nodeToBoolean(value) {
		switch (Utils.getBaseType(value)) {
			case Utils.T_BOOLEAN: return value;
			case Utils.T_NUMBER: return (value !== 0);
			case Utils.T_STRING: return (value.length > 0);
			case Utils.T_OBJECT: return (value instanceof OrderedMap);
			default: return false;
		}
	}

	function nodeToString(value) {
		switch (Utils.getBaseType(value)) {
			case Utils.T_UNDEFINED: return '';
			case Utils.T_NULL:
			case Utils.T_STRING:
			case Utils.T_BOOLEAN:
				return String(value);
			case Utils.T_NUMBER:
				var value = String(value).toLowerCase();
				if (value.indexOf('e') === -1) return value;
				value = value.split('e');
				var numericPart = value[0];
				var exponentPart = value[1];
				var numericSign = numericPart[0];
				var exponentSign = exponentPart[0];
				if (numericSign === '+' || numericSign === '-') {
					numericPart = numericPart.substr(1);
				} else numericSign = '';
				if (exponentSign === '+' || exponentSign === '-') {
					exponentPart = exponentPart.substr(1);
				} else exponentSign = '+';
				var lDecPlaces, rDecPlaces;
				var decPos = numericPart.indexOf('.');
				if (decPos === -1) {
					rDecPlaces = 0;
					lDecPlaces = numericPart.length;
				} else {
					rDecPlaces = numericPart.substr(decPos + 1).length;
					lDecPlaces = numericPart.substr(0, decPos).length;
					numericPart = numericPart.replace(/\./g, '');
				}
				var numZeros = exponentPart - lDecPlaces;
				if (exponentSign === '+') numZeros = exponentPart - rDecPlaces;
				for (var zeros = '', c = 0; c < numZeros; c++) zeros += '0';
				return (
					exponentSign === '+' ?
					numericSign + numericPart + zeros :
					numericSign + '0.' + zeros + numericPart
				);
		}
		if (Utils.isObject(value) && value instanceof OrderedMap) {
			var values = value.values();
			for (var c = 0; c < values.length; c++) {
				values[c] = nodeToString(values[c]);
			}
			return values.join(' ');
		}
		return '';
	}

	function doRequest(uri, success, fail, props) {

		var xhr = new XMLHttpRequest();//text.createXhr();
		xhr.open('GET', uri + '?' + Math.random(), true);

		xhr.onreadystatechange = function (evt) {
			if (xhr.readyState !== 4) return;

			// intelligent guess!
			var contentType = xhr.getResponseHeader('Content-type');

			var status = xhr.status;
			if (status > 399 && status < 600) fail();
			else {
				success(xhr.responseText, contentType);
			}
		};
		xhr.send(null);
	}

	function resolveURI(requestURI, baseURI, ret, requestProps) {
		if (!Utils.isFunction(URIResolver) || URIResolver(
			requestURI, baseURI, function(resourceData, resourceURI) {
			if (!Utils.isString(resourceURI)) resourceURI = requestURI;
			ret(resourceData, resourceURI);
		}, requestProps) !== true) {
			var resourceURI = Utils.uri.resolve(requestURI, baseURI);
			if (!resourceCache.hasOwnProperty(resourceURI)) {
				doRequest(resourceURI, function(resourceData) {
					resourceData = ret(resourceData, resourceURI);
					if (!Utils.isUndefined(resourceData)) {
						resourceCache[resourceURI] = resourceData;
					}
				}, function() {
					ret(undefined, resourceURI);
				}, requestProps);
			} else ret(resourceCache[resourceURI], resourceURI);
		}
	}

	function js2internal(value) {
		if (Utils.isFunction(value)) return;
		if (!Utils.isObject(value)) return value;
		if (value instanceof OrderedMap) return value;
		var orderedMap = new OrderedMap();
		for (var key in value) {
			if (!value.hasOwnProperty(key)) continue;
			orderedMap.set(key, js2internal(value[key]));
		}
		return orderedMap;
	}

	function internal2js(value) {
		if (Utils.isObject(value)) {
			if (value instanceof OrderedMap) {
				return value.toObject();
			} else for (var key in value) {
				value[key] = internal2js(value[key]);
			}
		}
		return value;
	}

	function getHandlerFor(value, name, isProp) {

		var handler = value;
		switch (Utils.getBaseType(value)) {
			case Utils.T_NULL: handler = Histone.Type; break;
			case Utils.T_BOOLEAN: handler = Histone.Type; break;
			case Utils.T_UNDEFINED: handler = Histone.Type; break;
			case Utils.T_NUMBER: handler = Histone.Number; break;
			case Utils.T_STRING: handler = Histone.String; break;
		}

		if (Utils.isObject(value) && value instanceof OrderedMap) {
			handler = Histone.Map;
		}

		if (handler.hasOwnProperty(name)) return handler[name];
		if (Histone.Type.hasOwnProperty(name)) return Histone.Type[name];
		if (isProp && handler.hasOwnProperty('')) return handler[''];
	}

	function processMap(items, stack, ret) {
		var result = new OrderedMap();
		Utils.forEachAsync(items, function(item, ret) {
			processNode(item[1], stack, function(value) {
				result.set(item[0], value);
				ret();
			});
		}, function() { ret(result); });
	}

	function processNot(value, stack, ret) {
		processNode(value, stack, function(value) {
			ret(!nodeToBoolean(value));
		});
	}

	function processOr(left, right, stack, ret) {
		processNode(left, stack, function(left) {
			if (nodeToBoolean(left)) ret(left);
			else processNode(right, stack, ret);
		});
	}

	function processAnd(left, right, stack, ret) {
		processNode(left, stack, function(left) {
			if (!nodeToBoolean(left)) ret(left);
			else processNode(right, stack, ret);
		});
	}

	function processTernary(condition, left, right, stack, ret) {
		processNode(condition, stack, function(condition) {
			if (nodeToBoolean(condition)) {
				processNode(left, stack, ret);
			} else if (right) {
				processNode(right, stack, ret);
			} else ret();
		});
	}

	function processEquality(left, right, stack, ret) {
		processNode(left, stack, function(left) {
			processNode(right, stack, function(right) {
				if (Utils.isString(left) && Utils.isNumber(right)) {
					if (!Utils.isNumeric(left)) left = parseFloat(left, 10);
					else right = nodeToString(right);
				} else if (Utils.isNumber(left) && Utils.isString(right)) {
					if (!Utils.isNumeric(right)) right = parseFloat(right, 10);
					else left = nodeToString(left);
				}
				if (!(Utils.isString(left) && Utils.isString(right))) {
					if (Utils.isNumber(left) && Utils.isNumber(right)) {
						left = parseFloat(left);
						right = parseFloat(right);
					} else {
						left = nodeToBoolean(left);
						right = nodeToBoolean(right);
					}
				}
				ret(left === right);
			});
		});
	}

	function processRelational(nodeType, left, right, stack, ret) {
		processNode(left, stack, function(left) {
			processNode(right, stack, function(right) {
				if (Utils.isString(left) && Utils.isNumber(right)) {
					if (Utils.isNumeric(left)) left = parseFloat(left, 10);
					else right = nodeToString(right);
				} else if (Utils.isNumber(left) && Utils.isString(right)) {
					if (Utils.isNumeric(right)) right = parseFloat(right, 10);
					else left = nodeToString(left);
				}
				if (!(Utils.isNumber(left) && Utils.isNumber(right))) {
					if (Utils.isString(left) && Utils.isString(right)) {
						left = left.length;
						right = right.length;
					} else {
						left = nodeToBoolean(left);
						right = nodeToBoolean(right);
					}
				}
				switch (nodeType) {
					case Parser.T_LESS_THAN: ret(left < right); break;
					case Parser.T_GREATER_THAN: ret(left > right); break;
					case Parser.T_LESS_OR_EQUAL: ret(left <= right); break;
					case Parser.T_GREATER_OR_EQUAL: ret(left >= right); break;
				}
			});
		});
	}

	function processAddition(left, right, stack, ret) {
		processNode(left, stack, function(left) {
			processNode(right, stack, function(right) {
				if (!(Utils.isString(left) || Utils.isString(right))) {
					if (Utils.isNumber(left) || Utils.isNumber(right)) {
						if (Utils.isNumeric(left)) left = parseFloat(left, 10);
						if (!Utils.isNumber(left)) return ret();
						if (Utils.isNumeric(right)) right = parseFloat(right, 10);
						if (!Utils.isNumber(right)) return ret();
						return ret(left + right);
					}
					else if (left instanceof OrderedMap &&
						right instanceof OrderedMap) {
						var result = left.clone();
						result = result.concat(right);
						return ret(result);
					}
				}
				left = nodeToString(left);
				right = nodeToString(right);
				ret(left + right);
			});
		});
	}

	function processArithmetical(nodeType, left, right, stack, ret) {
		processNode(left, stack, function(left) {
			if (Utils.isNumeric(left)) left = parseFloat(left, 10);
			if (!Utils.isNumber(left)) return ret();
			if (nodeType === Parser.T_NEGATE) return ret(-left);
			processNode(right, stack, function(right) {
				if (Utils.isNumeric(right)) right = parseFloat(right, 10);
				if (!Utils.isNumber(right)) return ret();
				switch (nodeType) {
					case Parser.T_SUB: ret(left - right); break;
					case Parser.T_MUL: ret(left * right); break;
					case Parser.T_DIV: ret(left / right); break;
					case Parser.T_MOD: ret(left % right); break;
				}
			});
		});
	}

	function processVar(name, value, stack, ret) {
		stack.save();
		processNode(value, stack, function(value) {
			stack.restore();
			stack.putVar(name, value);
			ret('');
		});
	}

	function processMacro(name, args, statements, stack, ret) {
		stack.putMacro(name, args, statements, stack.getBaseURI());
		ret('');
	}

	function processIf(conditions, stack, ret) {
		var result = '';
		Utils.forEachAsync(conditions, function(condition, ret) {
			processNode(condition[0], stack, function(condResult) {
				if (!nodeToBoolean(condResult)) return ret();
				stack.save();
				processNodes(condition[1], stack, function(value) {
					result = value;
					stack.restore();
					ret(true);
				});
			});
		}, function() { ret(result); });
	}

	function processFor(iterator, collection, statements, stack, ret) {
		processNode(collection, stack, function(collection) {
			if (collection instanceof OrderedMap && collection.length()) {
				var result = '', self;
				var keys = collection.keys();
				var values = collection.values();
				Utils.forEachAsync(values, function(
					value, ret, key, index, last) {
					stack.save();
					stack.putVar(iterator[0], js2internal(value));
					if (iterator[1]) stack.putVar(iterator[1], keys[index]);
					self = {last: last, index: index};
					stack.putVar('self', js2internal(self));
					processNodes(statements[0], stack, function(value) {
						result += value;
						stack.restore();
						ret();
					});
				}, function() { ret(result); });
			} else if (statements[1]) {
				stack.save();
				processNodes(statements[1], stack, function(result) {
					stack.restore();
					ret(result);
				});
			} else ret('');
		});
	}

	function evalSelector(subject, selector, stack, ret) {
		var prevSubj, handler;
		Utils.forEachAsync(selector, function(fragment, ret) {
			processNode(fragment, stack, function(fragment) {
				prevSubj = subject;
				if (handler = getHandlerFor(subject, fragment, true)) {
					if (Utils.isFunction(handler)) handler.call(
						stack, prevSubj, [fragment], function(value) {
							subject = js2internal(value);
							ret();
						}
					); else {
						subject = js2internal(handler);
						ret();
					}
				}
				else {
					subject = undefined;
					return ret(true);
				}
			});
		}, function() { ret(subject); });
	}

	function processSelector(path, stack, ret) {
		var context;
		var selector = path.slice(1);
		var fragment = path[0];
		if (!Utils.isString(fragment)) {
			return processNode(fragment, stack, function(subject) {
				evalSelector(subject, selector, stack, ret);
			});
		}
		if (fragment === 'global') {
			return evalSelector(
				Histone.Global,
				selector,
				stack,
				ret
			);
		}
		if (fragment === 'this') {
			return evalSelector(
				stack.context,
				selector,
				stack,
				ret
			);
		}
		stack.getVar(fragment, function(value, found) {
			if (found) return evalSelector(value, selector, stack, ret);
			if (Histone.Global.hasOwnProperty(fragment)) return evalSelector(
				Histone.Global, [fragment].concat(selector), stack, ret);
			context = stack.context;
			if (Utils.isObject(context) &&
				context instanceof OrderedMap &&
				context.hasKey(fragment)) return evalSelector(
				context, [fragment].concat(selector), stack, ret);
			evalSelector(undefined, selector, stack, ret);
		});
	}

	function callMacro(handler, args, stack, ret) {
		var macroArgs = handler[0];
		var macroBody = handler[1];
		var newBaseURI = handler[2];
		var oldBaseURI = stack.getBaseURI();
		var selfObj = {arguments: args};
		stack.save();
		stack.setBaseURI(newBaseURI);
		stack.putVar('self', js2internal(selfObj));
		for (var c = 0, arity = Math.min(
			args.length, macroArgs.length
		); c < arity; c++) stack.putVar(
			macroArgs[c], js2internal(args[c])
		);
		return processNodes(macroBody, stack, function(result) {
			stack.setBaseURI(oldBaseURI);
			stack.restore();
			ret(result);
		});
	}

	function processCall(target, name, args, stack, ret) {
		processNode(name, stack, function(name) {
			var callArgs = [];
			if (!Utils.isArray(args)) args = [];
			Utils.forEachAsync(args, function(arg, ret) {
				processNode(arg, stack, function(arg) {
					callArgs.push(arg);
					ret();
				});
			}, function() {
				var handler = null;
				if (Utils.isNull(target)) {
					if (handler = stack.getMacro(name))
						return callMacro(handler, callArgs, stack, ret);
						target = Histone.Global;
				}
				processNode(target, stack, function(target) {
					if (handler = getHandlerFor(target, name)) {
						if (Utils.isFunction(handler)) {
							handler.call(
								stack, target,
								internal2js(callArgs),
								function(value) {
								ret(js2internal(value));
							});
						} else ret(js2internal(handler));
					}
					else return ret();
				});
			});
		});
	}

	function processImport(requestURI, stack, ret) {
		var baseURI = stack.getBaseURI();

		if (!stack.imports) stack.imports = {};
		var importHash = (requestURI + '#' + baseURI);
		if (stack.imports.hasOwnProperty(importHash)) return ret();
		stack.imports[importHash] = true;

		resolveURI(requestURI, baseURI, function(resourceData, resourceURI) {
			try {
				resourceData = Histone(resourceData, resourceURI);
				stack.setBaseURI(resourceURI);
				processNodes(resourceData.getAST(), stack,
					function(resourceData) {
						stack.setBaseURI(baseURI);
						ret(resourceData);
					}
				);
				return resourceData;
			} catch (e) { ret(); }
		});
	}

	function processNode(node, stack, ret) {
		if (!Utils.isArray(node)) return ret(node);
		var nodeType = node[0];
		switch (nodeType) {
			case Parser.T_INT:
			case Parser.T_STRING:
			case Parser.T_DOUBLE: ret(node[1]); break;
			case Parser.T_SELECTOR: processSelector(node[1], stack, ret); break;
			case Parser.T_VAR: processVar(node[1], node[2], stack, ret); break;
			case Parser.T_IF: processIf(node[1], stack, ret); break;
			case Parser.T_CALL: processCall(node[1], node[2], node[3], stack, ret); break;
			case Parser.T_TERNARY: processTernary(node[1], node[2], node[3], stack, ret); break;
			case Parser.T_IMPORT: processImport(node[1], stack, ret); break;
			case Parser.T_EQUAL:
			case Parser.T_NOT_EQUAL:
				processEquality(node[1], node[2], stack, function(equals) {
					ret(nodeType === Parser.T_EQUAL ? equals : !equals);
				});
				break;
			case Parser.T_STATEMENTS: processNodes(node[1], stack, ret); break;
			case Parser.T_MACRO: processMacro(node[1], node[2], node[3], stack, ret); break;
			case Parser.T_MAP: processMap(node[1], stack, ret); break;
			case Parser.T_ADD: processAddition(node[1], node[2], stack, ret); break;
			case Parser.T_FOR: processFor(node[1], node[2], node[3], stack, ret); break;
			case Parser.T_TRUE: ret(true); break;
			case Parser.T_FALSE: ret(false); break;
			case Parser.T_OR: processOr(node[1], node[2], stack, ret); break;
			case Parser.T_AND: processAnd(node[1], node[2], stack, ret); break;
			case Parser.T_NULL: ret(null); break;
			case Parser.T_NOT: processNot(node[1], stack, ret); break;
			case Parser.T_SUB:
			case Parser.T_MUL:
			case Parser.T_DIV:
			case Parser.T_MOD:
			case Parser.T_NEGATE:
				processArithmetical(nodeType, node[1], node[2], stack, ret);
				break;
			case Parser.T_LESS_THAN:
			case Parser.T_GREATER_THAN:
			case Parser.T_LESS_OR_EQUAL:
			case Parser.T_GREATER_OR_EQUAL:
				processRelational(nodeType, node[1], node[2], stack, ret);
				break;
			default:
				ret();
				throw(
					'unsupported template instruction "' +
					nodeToString(node) + '"'
				);
		}
	}

	function processNodes(nodes, stack, ret) {
		var result = '';
		Utils.forEachAsync(nodes, function(node, ret) {
			if (Utils.isArray(node)) {
				processNode(node, stack, function(node) {
					result += nodeToString(node);
					ret();
				});
			} else {
				result += node;
				ret();
			}
		}, function() { ret(result); });
	}

	function Template(templateAST, baseURI) {

		if (!Utils.isString(baseURI)) {
			baseURI = '.';
		}

		this.getAST = function() {
			return templateAST;
		};

		this.render = function(ret, context) {
			var context = js2internal(context);
			var stack = new CallStack(context);
			stack.setBaseURI(baseURI);
			processNodes(templateAST, stack, ret);
		};

		this.call = function(name, args, ret, context) {
			var stack = new CallStack(context);
			var context = js2internal(context);
			stack.setBaseURI(baseURI);
			processNodes(templateAST, stack, function() {
				var handler = stack.getMacro(name);
				if (!handler) return ret();
				callMacro(handler, args, stack, function(value) {
					ret(internal2js(value));
				});
			});
		};

	}

	var Histone = function(template, baseURI) {
		if (Utils.isString(template)) {
			if (!parserInstance) parserInstance = new Parser();
			template = parserInstance.parse(template, baseURI);
		} else if (template instanceof Template) {
			return template;
		} else if (!Utils.isArray(template)) {
			template = String(template);
			throw('"' + template + '" is not a string');
		}
		return new Template(template, baseURI);
	};

	Histone.OrderedMap = OrderedMap;

	Histone.Type = {

		isUndefined: function(value, args, ret) {
			ret(Utils.isUndefined(value));
		},

		isNull: function(value, args, ret) {
			ret(Utils.isNull(value));
		},

		isBoolean: function(value, args, ret) {
			ret(Utils.isBoolean(value));
		},

		isNumber: function(value, args, ret) {
			ret(Utils.isNumber(value));
		},

		isString: function(value, args, ret) {
			ret(Utils.isString(value));
		},

		isMap: function(value, args, ret) {
			ret(Utils.isObject(value) && value instanceof OrderedMap);
		},

		toJSON: function(value, args, ret) {
			if (Utils.isUndefined(value)) return ret('null');
			ret(JSON.stringify(value));
		},

		toMap: function(value, args, ret) {
			if (value instanceof OrderedMap) return ret(value);
			ret(new OrderedMap().set(null, value));
		},

		toString: function(value, args, ret) {
			ret(nodeToString(value));
		},

		toBoolean: function(value, args, ret) {
			ret(nodeToBoolean(value));
		}
	};

	Histone.Number = {

		isInteger: function(value, args, ret) {
			ret(value % 1 === 0);
		},

		isFloat: function(value, args, ret) {
			ret(value % 1 !== 0);
		},

		toChar: function(value, args, ret) {
			ret(String.fromCharCode(value));
		},

		toFixed: function(value, args, ret) {
			var precision = args[0];
			if (Utils.isNumber(precision) && precision >= 0) {
				var power = Math.pow(10, precision || 0);
				ret(Math.round(value * power) / power);
			} else ret(value);
		},

		abs: function(value, args, ret) {
			ret(Math.abs(value));
		},

		floor: function(value, args, ret) {
			ret(Math.floor(value));
		},

		ceil: function(value, args, ret) {
			ret(Math.ceil(value));
		},

		round: function(value, args, ret) {
			ret(Math.round(value));
		},

		pow: function(value, args, ret) {
			var exp = args[0];
			if (!Utils.isNumber(exp)) return ret();
			ret(Math.pow(value, exp));
		},

		log: function(value, args, ret) {
			if (value <= 0) return ret();
			var base = args[0];
			if (Utils.isNumber(base) && base > 0) {
				ret(Math.log(value) / Math.log(base));
			} else ret(Math.log(value));
		}

	};

	Histone.String = {

		'': function(value, args, ret) {
			var index = parseFloat(args[0], 10);
			if (isNaN(index)) return ret();
			var length = value.length;
			if (index < 0) index = length + index;
			if (index % 1 !== 0 ||
				index < 0 ||
				index >= length) {
				return ret();
			}
			ret(value[index]);
		},

		length: function(value, args, ret) {
			ret(value.length);
		},

		strip: function(value, args, ret) {
			var chars = '', arg;
			while (args.length) {
				arg = args.shift();
				if (!Utils.isString(arg)) continue;
				chars += arg;
			}
			if (chars.length === 0) chars = ' \n\r\t';
			var start = -1, length = value.length;
			while (start < length && chars.indexOf(value.charAt(++start)) !== -1) {};
			while (length >= 0 && chars.indexOf(value.charAt(--length)) !== -1){};
			ret(value.slice(start, length + 1));
		},

		slice: function(value, args, ret) {
			var start = args[0];
			var length = args[1];
			var strLen = value.length;
			if (!Utils.isNumber(start)) start = 0;
			if (start < 0) start = strLen + start;
			if (start < 0) start = 0;
			if (start < strLen) {
				if (!Utils.isNumber(length)) length = 0;
				if (length === 0) length = strLen - start;
				if (length < 0) length = strLen - start + length;
				if (length <= 0) ret('');
				else ret(value.substr(start, length));
			} else ret('');
		},

		test: function(value, args, ret) {
			var regExp = args[0];
			ret(Utils.isString(regExp) &&
				value.match(regExp) !== null);
		},

		match: function(value, args, ret) {
			var regExp = args[0];
			if (!Utils.isString(regExp)) return ret(false);
			var match = value.match(regExp);
			if (Utils.isNull(match)) return ret(false);
			ret(Array.prototype.slice.call(match, 0));
		},

		toLowerCase: function(value, args, ret) {
			ret(value.toLowerCase());
		},

		toUpperCase: function(value, args, ret) {
			ret(value.toUpperCase());
		},

		split: function(value, args, ret) {
			var splitter = args[0];
			ret(value.split(Utils.isString(splitter) ? splitter : ''));
		},

		charCodeAt: function(value, args, ret) {
			var index = parseFloat(args[0], 10);
			if (isNaN(index)) return ret();
			var length = value.length;
			if (index < 0) index = length + index;
			if (index % 1 !== 0 ||
				index < 0 ||
				index >= length) {
				return ret();
			}
			ret(value.charCodeAt(index));
		},

		toNumber: function(value, args, ret) {
			if (!Utils.isNumeric(value)) ret();
			else ret(parseFloat(value, 10));
		}
	};

	Histone.Map = {

		'': function(value, args, ret) {
			var key = args[0];
			ret(value.get(key));
		},

		length: function(value, args, ret) {
			ret(value.length());
		},

		join: function(value, args, ret) {
			var separator = args[0];
			ret(value.join(separator));
		},

		keys: function(value, args, ret) {
			ret(value.keys());
		},

		values: function(value, args, ret) {
			ret(value.values());
		},

		hasKey: function(value, args, ret) {
			var key = args[0];
			ret(value.hasKey(key));
		},

		remove: function(value, args, ret) {
			var key, keys = args;
			var result = value.clone();
			while (keys.length) {
				key = keys.shift();
				result.remove(key);
			}
			ret(result);
		},

		slice: function(value, args, ret) {
			var offset = args[0];
			var length = args[1];
			var result = value.clone();
			result.slice(offset, length);
			ret(result);
		},

		toJSON: function(value, args, ret) {
			ret(JSON.stringify(value.toObject()));
		}

	};

	Histone.Global = {

		clientType: 'browser',

		userAgent: window.navigator.userAgent,

		baseURI: function(value, args, ret) {
			ret(this.getBaseURI());
		},

		uniqueId: function(value, args, ret) {
			ret(Utils.uniqueId());
		},

		loadJSON: function(value, args, ret) {
			var requestURI = args[0];
			var requestProps = args[1];
			var baseURI = this.getBaseURI();
			resolveURI(requestURI, baseURI, function(resouceData) {
				if (!Utils.isString(resouceData)) {
					resouceData = js2internal(resouceData);
					return ret(resouceData);
				}
				try {
					resouceData = JSON.parse(resouceData);
					resouceData = js2internal(resouceData);
					ret(resouceData);
				} catch (e) { ret(); }
			}, requestProps);
		},

		loadText: function(value, args, ret) {
			var requestURI = args[0];
			var requestProps = args[1];
			var baseURI = this.getBaseURI();
			resolveURI(requestURI, baseURI, function(resourceData) {
				ret(Utils.isString(resourceData) ? resourceData : '');
			}, requestProps);
		},

		include: function(value, args, ret) {
			var requestURI = args[0];
			var context = args[1];
			var baseURI = this.getBaseURI();
			resolveURI(requestURI, baseURI, function(
				resourceData, resourceURI) {
				try {
					resourceData = Histone(resourceData, resourceURI);
					resourceData.render(ret, js2internal(context));
					return resourceData;
				} catch (e) { ret(); }
			});
		},

		min: function(value, values, ret) {
			var count = values.length;
			var minValue = undefined;
			for (var c = 0; c < count; c++) {
				if (Utils.isNumber(values[c]) && (
					Utils.isUndefined(minValue) ||
					values[c] < minValue
				)) minValue = values[c];
			}
			ret(minValue);
		},

		max: function(value, values, ret) {
			var count = values.length;
			var maxValue = undefined;
			for (var c = 0; c < count; c++) {
				if (Utils.isNumber(values[c]) && (
					Utils.isUndefined(maxValue) ||
					values[c] > maxValue
				)) maxValue = values[c];
			}
			ret(maxValue);
		},

		range: function(value, args, ret) {
			var result = [];
			var start = parseFloat(args[0]);
			var end = parseFloat(args[1]);
			if (!Utils.isNumber(start) ||
				!Utils.isNumber(end) ||
				start % 1 !== 0 ||
				end % 1 !== 0) {
				return ret(result);
			}
			if (start > end) {
				for (var i = start; i >= end; i -= 1) result.push(i);
			} else if (start < end) {
				for (var i = start; i <= end; i += 1) result.push(i);
			} else result.push(start);
			ret(result);
		},

		dayOfWeek: function(value, args, ret) {
			var year = parseFloat(args[0]);
			var month = parseFloat(args[1]);
			var day = parseFloat(args[2]);
			if (!Utils.isNumber(year) ||
				!Utils.isNumber(month) ||
				!Utils.isNumber(day) ||
				year % 1 !== 0 ||
				month % 1 !== 0 ||
				day % 1 !== 0) {
				return ret();
			}
			var date = new Date(year, month -= 1, day);
			if (date.getFullYear() == year &&
				date.getMonth() == month &&
				date.getDate() == day) {
				var day = date.getDay();
				ret(day ? day : 7);
			} else ret();
		}
	};

	Histone.load = function(name, req, load, config) {
		var requestURI = req.toUrl(name);
		doRequest(requestURI, function(resourceData, contentType) {
			if (contentType === 'application/json') try {
				resourceData = JSON.parse(resourceData);
			} catch (e) {}
			load(Histone(resourceData, requestURI));
		}, null);
	};

	Histone.setURIResolver = function(callback) {
		if (!Utils.isFunction(callback)) {
			URIResolver = null;
		} else {
			URIResolver = callback;
		}
	};

	return Histone;

});