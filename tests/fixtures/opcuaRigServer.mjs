/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An OPC UA server standing in for a lab's PLC, for the tests: an object Rig2 with two analog tags, TankTemperature (in kelvin, with
// a range) and HeaterPower (in watts), whose values the test sets with their own source timestamps and status codes, as a PLC
// reporting a measurement would. It takes connections with no security, and signed and encrypted ones, accepting the client's
// certificate (a lab server is set up to trust its clients); its own PKI lives in `pkiFolder`.

import { OPCUAServer } from 'node-opcua-server';
import { standardUnits } from 'node-opcua-data-access';
import { DataType, MessageSecurityMode, SecurityPolicy, StatusCodes, Variant } from 'node-opcua-client';
import { OPCUACertificateManager } from 'node-opcua-certificate-manager';

export async function startRigServer({ pkiFolder }) {
    const serverCertificateManager = new OPCUACertificateManager({ rootFolder: pkiFolder, automaticallyAcceptUnknownCertificate: true });
    const server = new OPCUAServer({
        port: 0, resourcePath: '/UA/Rig', hostname: 'localhost', buildInfo: { productName: 'Konjugate test rig' }, serverCertificateManager,
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
    const tags = {
        TankTemperature: tag('TankTemperature', standardUnits.kelvin ?? standardUnits.degree_kelvin, { low: 250, high: 400 }, 293.15),
        HeaterPower: tag('HeaterPower', standardUnits.watt, { low: 0, high: 2000 }, 0)
    };
    await server.start();
    return {
        url: `opc.tcp://localhost:${server.endpoints[0].port}/UA/Rig`,
        nodeId: (name) => tags[name].nodeId.toString(),
        // A new value, measured at `time` (a Date), with a quality: 'good' or 'bad'.
        set(name, value, time, quality = 'good') {
            tags[name].setValueFromSource(new Variant({ dataType: DataType.Double, value }), quality === 'good' ? StatusCodes.Good : StatusCodes.BadSensorFailure, time);
        },
        shutdown: () => server.shutdown()
    };
}
