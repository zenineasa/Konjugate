/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An OPC UA server standing in for a lab's PLC, for the tests: an object Rig2 with two analog tags, TankTemperature (in kelvin, with
// a range) and HeaterPower (in watts), whose values the test sets with their own source timestamps and status codes, as a PLC
// reporting a measurement would. It takes connections with no security, and signed and encrypted ones, accepting the client's
// certificate (a lab server is set up to trust its clients); its own PKI lives in `pkiFolder`.
//
// For the source's own tests (tests/opcuaSource.test.mjs) it also has a true/false tag HeaterOn and a text tag OperatorNote, and
// `extraTags` more analog tags Tag0, Tag1, ...; `port` starts it on a given port, so a test can stop it and start it again where it
// was, as a PLC restarting does.

import { OPCUAServer } from 'node-opcua-server';
import { standardUnits } from 'node-opcua-data-access';
import { DataType, MessageSecurityMode, SecurityPolicy, StatusCodes, Variant } from 'node-opcua-client';
import { OPCUACertificateManager } from 'node-opcua-certificate-manager';

export async function startRigServer({ pkiFolder, port = 0, extraTags = 0 }) {
    const serverCertificateManager = new OPCUACertificateManager({ rootFolder: pkiFolder, automaticallyAcceptUnknownCertificate: true });
    const server = new OPCUAServer({
        port, resourcePath: '/UA/Rig', hostname: 'localhost', buildInfo: { productName: 'Konjugate test rig' }, serverCertificateManager,
        securityModes: [MessageSecurityMode.None, MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt],
        securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256], allowAnonymous: true
    });
    await server.initialize();
    const space = server.engine.addressSpace;
    const namespace = space.getOwnNamespace();
    const rig = namespace.addObject({ organizedBy: space.rootFolder.objects, browseName: 'Rig2' });
    const tag = (browseName, unit, range, initial) => namespace.addAnalogDataItem({
        componentOf: rig, browseName, nodeId: `s=Rig2.${browseName}`, dataType: 'Double', minimumSamplingInterval: 0,
        engineeringUnitsRange: range, engineeringUnits: unit, value: new Variant({ dataType: DataType.Double, value: initial })
    });
    const plain = (browseName, dataType, initial) => namespace.addVariable({
        componentOf: rig, browseName, nodeId: `s=Rig2.${browseName}`, dataType, minimumSamplingInterval: 0,
        value: new Variant({ dataType: DataType[dataType], value: initial })
    });
    const tags = {
        TankTemperature: tag('TankTemperature', standardUnits.kelvin ?? standardUnits.degree_kelvin, { low: 250, high: 400 }, 293.15),
        HeaterPower: tag('HeaterPower', standardUnits.watt, { low: 0, high: 2000 }, 0),
        HeaterOn: plain('HeaterOn', 'Boolean', false),
        OperatorNote: plain('OperatorNote', 'String', '')
    };
    for (let index = 0; index < extraTags; index += 1) tags[`Tag${index}`] = tag(`Tag${index}`, standardUnits.watt, { low: 0, high: 1e6 }, 0);
    await server.start();
    return {
        url: `opc.tcp://localhost:${server.endpoints[0].port}/UA/Rig`,
        nodeId: (name) => tags[name].nodeId.toString(),
        port: server.endpoints[0].port,
        // A new value, measured at `time` (a Date), with a quality: 'good', 'uncertain' or 'bad'. The value's type is the tag's own.
        set(name, value, time, quality = 'good') {
            const dataType = typeof value === 'boolean' ? DataType.Boolean : typeof value === 'string' ? DataType.String : DataType.Double;
            const status = { good: StatusCodes.Good, uncertain: StatusCodes.UncertainLastUsableValue, bad: StatusCodes.BadSensorFailure }[quality];
            tags[name].setValueFromSource(new Variant({ dataType, value }), status, time);
        },
        shutdown: () => server.shutdown()
    };
}
