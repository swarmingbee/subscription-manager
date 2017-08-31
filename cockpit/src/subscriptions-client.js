/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2016 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

var cockpit = require("cockpit");
var service = cockpit.dbus('com.redhat.RHSM1', {'superuser': 'require'});
var registerServer = service.proxy('com.redhat.RHSM1.RegisterServer', '/com/redhat/RHSM1/RegisterServer');
var attachService = service.proxy('com.redhat.RHSM1.Attach', '/com/redhat/RHSM1/Attach');
var entitlementService = service.proxy('com.redhat.RHSM1.Entitlement', '/com/redhat/RHSM1/Entitlement');
var unregisterService = service.proxy('com.redhat.RHSM1.Unregister', '/com/redhat/RHSM1/Unregister');
var productsService = service.proxy('com.redhat.RHSM1.Products', '/com/redhat/RHSM1/Products');
var legacyService = cockpit.dbus('com.redhat.SubscriptionManager');  // FIXME replace?
var _ = cockpit.gettext;

var client = { };

cockpit.event_target(client);

client.subscriptionStatus = {
    serviceStatus: undefined,
    status: undefined,
    products: [],
    error: undefined,
};

// we trigger an event called "dataChanged" when the data has changed

function needRender() {
    var ev = document.createEvent("Event");
    ev.initEvent("dataChanged", false, false);
    client.dispatchEvent(ev);
}

/* we trigger status update via dbus
 * if we don't get a timely reply, consider subscription-manager failure
 */
var updateTimeout;

function parseProducts(text) {
    var products = JSON.parse(text);
    return products.map(function(product) {
        return {
            'productName': product[0],
            'productId': product[1],
            'version': product[2],
            'arch': product[3],
            'status': product[4],
            /* TODO start date and end date */
        };
    });
}

var gettingDetails = false;
var getDetailsRequested = false;
function getSubscriptionDetails() {
    if (gettingDetails) {
        getDetailsRequested = true;
        return;
    }
    getDetailsRequested = false;
    gettingDetails = true;
    productsService.ListInstalledProducts('', {})
        .then(function(result) {
            client.subscriptionStatus.products = parseProducts(result);
        })
        .catch(function(ex) {
            client.subscriptionStatus.error = ex;
        })
        .then(function(output) {
            gettingDetails = false;
            if (getDetailsRequested)
                getSubscriptionDetails();
            needRender();
        });
}

client.registerSystem = function(subscriptionDetails) {
    var dfd = cockpit.defer();

    var options = {};

    if (subscriptionDetails.activationKeys) {
        options.activation_keys = {
            t: 'as',
            v: subscriptionDetails.activationKeys.split(','),
        };
    }

    if (subscriptionDetails.url != 'default') {
        /*  parse url into host, port, handler; sorry about the ugly regex
            (?:https?://)? strips off the protocol if it exists
            ([$/:]+) matches the hostname
            (?::(?=[0-9])([0-9]+))? matches the port if it exists
            (?:(/.+)) matches the rest for the path
        */
        pattern = new RegExp('^(?:https?://)?([^/:]+)(?::(?=[0-9])([0-9]+))?(?:(/.+))?$');
        match = pattern.exec(subscriptionDetails.url); // TODO handle failure
        options.host = {
            t: 's',
            v: match[1],
        };
        options.port = {
            t: 's',
            v: match[2],
        };
        options.handler = {
            t: 's',
            v: match[3],
        };
    }

    var connection_options = {};
    // proxy is optional
    if (subscriptionDetails.proxy) {
        connection_options.proxy_hostname = {
            t: 's',
            v: subscriptionDetails.proxyServer,
        };
        connection_options.proxy_user = {
            t: 's',
            v: subscriptionDetails.proxyUser,
        }
        connection_options.proxy_password = {
            t: 's',
            v: subscriptionDetails.proxyPass,
        }
    }

    registerServer.Start()
        .then(function(socket) {
            console.debug('Opening private bus interface at ' + socket);
            var private_interface = cockpit.dbus(null, {bus: 'none', address: socket, superuser: 'require'});
            var registerService = private_interface.proxy('com.redhat.RHSM1.Register', '/com/redhat/RHSM1/Register');
            if (subscriptionDetails.activationKeys) {
                return registerService.call('RegisterWithActivationKeys', [subscriptionDetails.org, subscriptionDetails.activationKeys, options, connection_options]);
            }
            else {
                return registerService.call('Register', [subscriptionDetails.org, subscriptionDetails.user, subscriptionDetails.password, options, connection_options]);
            }
        })
        .catch(function(error) {
            console.error('error initiating registration', error)
            throw error;
        })
        .then(function() {
            return registerServer.Stop();
        })
        .catch(function(error) {
            console.error('error registering', error);
            throw error;
        })
        .then(function() {
            return attachService.AutoAttach('', {});
        })
        .catch(function(error) {
            console.error('error stopping registration bus!', error);
            throw error;
        })
        .then(function(result) {
            console.log('requesting update');
            requestUpdate();
        })
        .catch(function(error) {
            console.error('error during attach', error);
            throw error;
        });
};

client.unregisterSystem = function() {
    client.subscriptionStatus.status = "Unregistering";
    needRender();
    unregisterService.Unregister({})
        .always(function() {
            requestUpdate();
        });
};

/* request update via DBus
 * possible status values: https://github.com/candlepin/subscription-manager/blob/30c3b52320c3e73ebd7435b4fc8b0b6319985d19/src/rhsm_icon/rhsm_icon.c#L98
 * [ RHSM_VALID, RHSM_EXPIRED, RHSM_WARNING, RHN_CLASSIC, RHSM_PARTIALLY_VALID, RHSM_REGISTRATION_REQUIRED ]
 */
var subscriptionStatusValues = [
    'RHSM_VALID',
    'RHSM_EXPIRED',
    'RHSM_WARNING',
    'RHN_CLASSIC',
    'RHSM_PARTIALLY_VALID',
    'RHSM_REGISTRATION_REQUIRED'
];
function requestUpdate() {
    legacyService.call(
        '/EntitlementStatus',
        'com.redhat.SubscriptionManager.EntitlementStatus',
        'check_status',
        [])
        .always(function() {
            window.clearTimeout(updateTimeout);
        })
        .done(function(result) {
            client.subscriptionStatus.serviceStatus = subscriptionStatusValues[result[0]];
            client.getSubscriptionStatus();
        })
        .catch(function(ex) {
            statusUpdateFailed("EntitlementStatus.check_status() failed:", ex);
        });

    /* TODO: Don't use a timeout here. Needs better API */
    updateTimeout = window.setTimeout(
        function() {
            statusUpdateFailed("timeout");
        }, 60000);
}

var gettingStatus = false;
var getStatusRequested = false;
/* get subscription summary */
client.getSubscriptionStatus = function() {
    if (gettingStatus) {
        getStatusRequested = true;
        return;
    }
    getStatusRequested = false;
    gettingStatus = true;

    entitlementService.GetStatus('')
        .then(function(result) {
            var status = JSON.parse(result);
            client.subscriptionStatus.status = status.status;
        })
        .catch(function(error) {
            client.subscriptionStatus.status = 'Unknown';
        })
        .then(function() {
            gettingStatus = false;
            getSubscriptionDetails();
            needRender();
        });
};

client.init = function() {
    /* we want to get notified if subscription status of the system changes */
    legacyService.subscribe(
        { path: '/EntitlementStatus',
          interface: 'com.redhat.SubscriptionManager.EntitlementStatus',
          member: 'entitlement_status_changed'
        },
        function(path, dbus_interface, signal, args) {
            window.clearTimeout(updateTimeout);
            /*
             * status has changed, now get actual status via command line
             * since older versions of subscription-manager don't deliver this via DBus
             * note: subscription-manager needs superuser privileges
             */

            client.getSubscriptionStatus();
        }
    );

    /* ideally we could get detailed subscription info via DBus, but we
     * can't rely on this being present on all systems we work on
     */
    legacyService.subscribe(
        { path: "/EntitlementStatus",
          interface: "org.freedesktop.DBUS.Properties",
          member: "PropertiesChanged"
        },
        function(path, iface, signal, args) {
            client.getSubscriptionStatus();
        }
    );

    // get initial status
    requestUpdate();
};

module.exports = client;
