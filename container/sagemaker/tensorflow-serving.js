var tfs_base_uri = '/tfs/v1/models/'
var custom_attributes_header = 'X-Amzn-SageMaker-Custom-Attributes'

function invocations(r) {
    var ct = r.headersIn['Content-Type']

    if ('application/json' == ct || 'application/jsonlines' == ct || 'application/jsons' == ct) {
        json_request(r)
    } else if ('text/csv' == ct) {
        csv_request(r)
    } else {
        return_error(r, 415, 'Unsupported Media Type: ' + (ct || 'Unknown'))
    }
}

function ping(r) {
    if ('1.11' == r.variables.tfs_version) {
        return ping_tfs_1_11(r)
    }

    var uri = make_tfs_uri(r, false)

    function callback (reply) {
        if (reply.status == 200 && reply.responseBody.includes('"AVAILABLE"')) {
            r.return(200)
        } else {
            r.error('failed ping' + reply.responseBody)
            r.return(502)
        }
    }

    r.subrequest(uri, callback)
}

function ping_tfs_1_11(r) {
    // hack for TF 1.11
    // send an arbitrary fixed request to the default model.
    // if response is 400, the model is ok (but input was bad), so return 200
    // also return 200 in unlikely case our request was really valid

    var uri = make_tfs_uri(r, true)
    var options = {
        method: 'POST',
        body: '{"instances": "invalid"}'
    }

    function callback (reply) {
        if (reply.status == 200 || reply.status == 400) {
            r.return(200)
        } else {
            r.error('failed ping' + reply.responseBody)
            r.return(502)
        }
    }

    r.subrequest(uri, options, callback)
}

function return_error(r, code, message) {
    if (message) {
        r.return(code, '{"error": "' + message + '"}')
    } else {
        r.return(code)
    }
}

function parseBool(value) {
    return value === true || value === 'true' || value === '1';
}

var conversions = {'DT_FLOAT': parseFloat, 'DT_INT32': parseInt, 'DT_BOOL': parseBool, 'DT_STRING': String};
var default_values = {'DT_FLOAT': 0.0, 'DT_INT32': 0, 'DT_BOOL': false, 'DT_STRING': ''};

function cast_payload(r, json) {
    var payload = JSON.parse(json);
    var payload_with_cast = {"instances": []};

    var metadata = JSON.parse(r.variables.tfs_metadata);

    r.log('-------> TFS METADATA:\n' + JSON.stringify(metadata));

    var metadata_inputs = metadata['metadata']['signature_def']['signature_def']['serving_default']['inputs'];

    var keys = Object.keys(metadata_inputs);

    payload["instances"].forEach(function (instance, instance_index) {
        var new_instance = {};
        keys.forEach(function (name, index) {
            var dtype = metadata_inputs[name]['dtype'];

            if (name in instance) {
                var value = instance[name];

                new_instance[name] = conversions[dtype](value);


                r.log('-------> CASTING  FIELD ' + name + ' previous: ' + value + ' ,current: ' + new_instance[name]);
            } else {
                new_instance[name] = default_values[dtype];

                r.log('-------> CREATING FIELD ' + name + ' with default: ' + new_instance[name]);
            }
        });
        payload_with_cast["instances"].push(new_instance);
    });

    r.log('-------> original payload\n' + JSON.stringify(payload));

    r.log('-------> final request to TFS\n' + JSON.stringify(payload_with_cast));

    return JSON.stringify(payload_with_cast);
}

function tfs_json_request(r, json) {
    var uri = make_tfs_uri(r, true)
    var options = {
        method: 'POST',
        body: cast_payload(r, json)
    }

    function callback (reply) {
        var body = reply.responseBody
        if (reply.status == 400) {
            // "fix" broken json escaping in \'instances\' message
            body = body.replace("\\'instances\\'", "'instances'")
        }

        r.log('-----> RESPONSE');
        r.log(body)
        r.return(reply.status, body)
    }

    r.subrequest(uri, options, callback)
}

function make_tfs_uri(r, with_method) {
    var attributes = parse_custom_attributes(r)

    var uri = tfs_base_uri + (attributes['tfs-model-name'] || r.variables.default_tfs_model)
    if ('tfs-model-version' in attributes) {
        uri += '/versions/' + attributes['tfs-model-version']
    }

    if (with_method) {
        uri += ':' + (attributes['tfs-method'] || 'predict')
    }

    return uri
}

function parse_custom_attributes(r) {
    var attributes = {}
    var kv_pattern = /tfs-[a-z\-]+=[^,]+/g
    var header = r.headersIn[custom_attributes_header]
    var matches = header.match(kv_pattern)
    if (matches) {
        for (var i = 0; i < matches.length; i++) {
            var kv = matches[i].split('=')
            if (kv.length === 2) {
                attributes[kv[0]] = kv[1]
            }
        }
    }
    return attributes
}

function json_request(r) {
    var data = r.requestBody

    if (is_json_lines(data)) {
        json_lines_request(r, data)
    } else if (is_tfs_json(data)) {
        tfs_json_request(r, data)
    } else {
        generic_json_request(r, data)
    }
}

function is_tfs_json(data) {
    return /"(instances|inputs|examples)"\s*:/.test(data)
}

function is_json_lines(data) {
    // objects separated only by (optional) whitespace means jsons/json-lines
    return /[}\]]\s*[\[{]/.test(data)
}

function generic_json_request(r, data) {
    if (! /^\s*\[\s*\[/.test(data)) {
        data = '[' + data + ']'
    }

    var json = '{"instances":' + data + '}'
    tfs_json_request(r, json)
}

function json_lines_request(r, data) {
    var lines = data.trim().split(/\r?\n/)
    var json = '{"instances":'
    if (lines.length != 1) {
        json += '['
    }

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim()
        if (line) {
            var instance = (i == 0) ? '' : ','
            instance += line
            json += instance
        }
    }

    json += lines.length == 1 ? '}' : ']}'
    tfs_json_request(r, json)
}

function csv_request(r) {
    var data = r.requestBody

    // look for initial quote or numeric-only data in 1st field
    var needs_quotes = data.search(/^\s*("|[\d.Ee+\-]+\s*,)/) != 0

    var lines = data.trim().split(/\r?\n/)

    // start instances json - omit outer list for single example
    var json = '{"instances":'
    if (lines.length != 1) {
        json += '['
    }

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim()
        if (line) {
            var instance = (i == 0) ? '[' : ',['

            if (needs_quotes) {
                instance += '"'
                instance += line.replace(',', '","')
                instance += '"'
            } else {
                instance += line
            }

            instance += ']'

            json += instance
        }
    }

    // end instances json - omit outer list for single example
    json += lines.length == 1 ? '}' : ']}'

    tfs_json_request(r, json)
}
