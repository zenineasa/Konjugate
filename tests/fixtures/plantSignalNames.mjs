/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Signals as plants, vendors and labs name them, against the example models they would be matched to (docs/proposals/controlRoom.md,
// "Finding the matches"): abbreviations, instrument tags, other words for the same thing, units of their own or none, and a few
// signals the model has nothing for. Each expects the label of the model quantity it is, or null. Written as such sources write them,
// not to suit the matcher: tests/signalMatchingCorpus.test.mjs measures how many the matcher gets right.

export const plantSignalNames = [
    {
        model: 'batteryPoweredJoint.kjt',
        signals: [
            { name: 'BMS_PackVoltage', unit: 'V', expected: 'Battery · Voltage' },
            { name: 'BMS_SOC', unit: '%', expected: 'Battery · State of charge' },
            { name: 'BMS_CellTempMax', unit: '°C', expected: 'Battery · Temperature' },
            { name: 'Drive_Iq_A', unit: 'A', expected: 'Motor · Armature current' },
            { name: 'Drive_ShaftSpeed', unit: 'rpm', expected: 'Motor · Angular velocity' },
            { name: 'Load_Torque_Nm', unit: 'N·m', expected: 'Load torque · Load torque' },
            { name: 'Motor_Case_Temp', unit: '°C', expected: 'Motor housing · Temperature' },
            { name: 'OAT', unit: '°C', expected: 'Ambient air · Temperature' },
            { name: 'Fan_Duty', unit: '%', expected: null }
        ]
    },
    {
        model: 'twoRoomBuilding.kjt',
        signals: [
            { name: 'LivingRm_Temp', unit: '°F', expected: 'Living room · Air temperature' },
            { name: 'Bedroom2_T', unit: '°C', expected: 'Bedroom · Air temperature' },
            { name: 'Outside_Air_Temp', unit: '°C', expected: 'Outdoor air · Temperature' },
            { name: 'CO2_ppm', unit: 'ppm', expected: null }
        ]
    },
    {
        model: 'springMassDamper.kjt',
        signals: [
            { name: 'LVDT_Mass_mm', unit: 'mm', expected: 'Suspended mass · Displacement' },
            { name: 'Mass_Vel', unit: 'm/s', expected: 'Suspended mass · Velocity' },
            { name: 'Base_Disp', unit: 'm', expected: 'Fixed support · Displacement' },
            { name: 'Base_Velocity', unit: 'm/s', expected: 'Fixed support · Velocity' }
        ]
    },
    {
        model: 'wheeledRobotDrivetrain.kjt',
        signals: [
            { name: 'bus_voltage', unit: 'V', expected: 'Drive supply · Voltage' },
            { name: 'motor_current', unit: 'A', expected: 'Drive motor · Armature current' },
            { name: 'wheel_motor_rpm', unit: 'rpm', expected: 'Drive motor · Angular velocity' },
            { name: 'odom_x', unit: 'm', expected: 'Chassis · Position' },
            { name: 'odom_vx', unit: 'm/s', expected: 'Chassis · Velocity' },
            { name: 'friction_torque_est', unit: 'N·m', expected: 'Bearing friction · Load torque' }
        ]
    },
    {
        model: 'pumpSuctionHydraulics.kjt',
        signals: [
            { name: 'Tank_Headspace_Press', unit: 'kPa', expected: 'Tank · Surface pressure' },
            { name: 'Line1_Flow', unit: 'L/min', expected: 'Suction Line 1 · Flow rate' },
            { name: 'SuctionLine3_Q', unit: 'm3/h', expected: 'Suction Line 3 · Flow rate' },
            { name: 'Pump_Suction_PSI', unit: 'psi', expected: 'Pump · Suction pressure' },
            { name: 'NPSHa_margin', unit: 'm', expected: 'Pump · NPSH margin' },
            { name: 'Pump_Vibration', unit: 'mm/s', expected: null }
        ]
    },
    {
        model: 'thermalManagement.kjt',
        signals: [
            { name: 'Module_Temp', unit: '°C', expected: 'Battery module · Temperature' },
            { name: 'Module_SOC', unit: '%', expected: 'Battery module · State of charge' },
            { name: 'Enclosure_Air_T', unit: '°C', expected: 'Enclosed air · Temperature' },
            { name: 'Losses_W', unit: 'W', expected: 'Electrical losses · Heat flow' }
        ]
    },
    {
        model: 'positionControlledJoint.kjt',
        signals: [
            { name: 'Supply_V', unit: 'V', expected: 'Voltage source · Voltage' },
            { name: 'Motor_Amps', unit: 'A', expected: 'Motor · Armature current' },
            { name: 'Motor_Speed', unit: 'rad/s', expected: 'Motor · Angular velocity' },
            { name: 'Encoder_Angle_deg', unit: 'deg', expected: 'Joint link · Angle' },
            { name: 'Link_Rate', unit: 'deg/s', expected: 'Joint link · Angular velocity' }
        ]
    },
    {
        model: 'dataSources/labVessel.kjt',
        signals: [
            { name: 'TC1 (°C)', unit: '°C', expected: 'Vessel water · Water temperature' },
            { name: 'Heater_Power_kW', unit: 'kW', expected: 'Shared · Heater power' },
            { name: 'Cold_Water_Flow', unit: 'kg/s', expected: 'Shared · Inflow' },
            { name: 'Lab_Ambient', unit: '°C', expected: 'Shared · Room temperature' }
        ]
    },
    {
        model: 'singleJointActuator.kjt',
        signals: [
            { name: 'DC_Bus_V', unit: 'V', expected: 'DC supply · Voltage' },
            { name: 'Armature_I', unit: 'A', expected: 'Motor · Armature current' },
            { name: 'Omega_motor', unit: 'rad/s', expected: 'Motor · Angular velocity' },
            { name: 'Load_Trq', unit: 'N·m', expected: 'Load torque · Load torque' }
        ]
    },
    {
        model: 'dataSources/simulatedTankRig.kjt',
        signals: [
            // A Konjugate data log says which of its signals are inputs.
            { name: 'TK1_TT101_PV', unit: '°C', role: 'output', expected: 'Water tank · Water temperature' },
            { name: 'TK1_JI101_PV', unit: 'kW', role: 'input', expected: 'Shared · Heater power' },
            { name: 'Lab_RoomTemp', unit: '°C', role: 'output', expected: 'Ambient air · Temperature' },
            { name: 'Htr_Element_HeatOut', unit: 'W', role: 'output', expected: 'Electric heater · Heat flow' }
        ]
    },
    // A broker's topics, the site's name first: "lab" here is where, not the room around the tank.
    {
        model: 'dataSources/simulatedTankRig.kjt',
        signals: [
            { name: 'lab/rig/tank/temperature', expected: 'Water tank · Water temperature' },
            { name: 'lab/rig/heater/power', expected: 'Shared · Heater power' }
        ]
    },
    // The same, as names alone: a broker's topics and a script's signals often carry no unit.
    {
        model: 'batteryPoweredJoint.kjt',
        signals: [
            { name: 'plant/battery/voltage', expected: 'Battery · Voltage' },
            { name: 'plant/battery/soc', expected: 'Battery · State of charge' },
            { name: 'plant/battery/temperature', expected: 'Battery · Temperature' },
            { name: 'plant/motor/current', expected: 'Motor · Armature current' },
            { name: 'plant/motor/speed', expected: 'Motor · Angular velocity' },
            { name: 'plant/motor/housing_temp', expected: 'Motor housing · Temperature' }
        ]
    },
    {
        model: 'wheeledRobotDrivetrain.kjt',
        signals: [
            { name: 'robot.drive.supply_volts', expected: 'Drive supply · Voltage' },
            { name: 'robot.drive.motor_amps', expected: 'Drive motor · Armature current' },
            { name: 'robot.odometry.distance', expected: 'Chassis · Position' },
            { name: 'robot.odometry.speed', expected: 'Chassis · Velocity' }
        ]
    }
];

// Written after the matcher's vocabulary, abbreviations and number rule were settled on the list above, and not used to tune them:
// how it does on names it has not been fitted to.
export const heldOutSignalNames = [
    {
        model: 'twoLinkArm.kjt',
        signals: [
            { name: 'ns=2;s=Arm.J1.SupplyVolts', unit: 'V', expected: 'Joint 1 supply · Voltage' },
            { name: 'ns=2;s=Arm.J2.SupplyVolts', unit: 'V', expected: 'Joint 2 supply · Voltage' },
            { name: 'J1_MotorCurrent', unit: 'A', expected: 'Joint 1 motor · Armature current' },
            { name: 'J2_MotorCurrent', unit: 'A', expected: 'Joint 2 motor · Armature current' },
            { name: 'Joint1_Encoder', unit: 'deg', expected: 'Joint 1 link · Angle' },
            { name: 'Joint2_Encoder', unit: 'deg', expected: 'Joint 2 link · Angle' },
            { name: 'J1_Motor_RPM', unit: 'rpm', expected: 'Joint 1 motor · Angular velocity' },
            { name: 'J2_Link_Rate', unit: 'deg/s', expected: 'Joint 2 link · Angular velocity' },
            { name: 'Gripper_Force', unit: 'N', expected: null }
        ]
    },
    {
        model: 'thermalEquilibrium.kjt',
        signals: [
            { name: 'HotBlock_TC', unit: '°C', expected: 'Hot body · Temperature' },
            { name: 'ColdBlock_TC', unit: '°C', expected: 'Cold body · Temperature' }
        ]
    },
    {
        model: 'heatedWaterTank.kjt',
        signals: [
            { name: 'DB10.Tank.WaterTemp', unit: '°C', expected: 'Water tank · Water temperature' },
            { name: 'DB10.Heater.Output_kW', unit: 'kW', expected: 'Electric heater · Heat flow' },
            { name: 'DB10.Room.Temp', unit: '°C', expected: 'Ambient air · Temperature' },
            { name: 'DB10.Tank.Level', unit: 'mm', expected: null }
        ]
    },
    {
        model: 'thermalManagement.kjt',
        signals: [
            { name: 'pack/temperature', expected: 'Battery module · Temperature' },
            { name: 'pack/charge_level', expected: 'Battery module · State of charge' },
            { name: 'cabinet/air_temp', expected: 'Enclosed air · Temperature' },
            { name: 'pack/heat_dissipation', expected: 'Electrical losses · Heat flow' }
        ]
    },
    {
        model: 'springMassDamper.kjt',
        signals: [
            { name: 'Payload_Position', unit: 'mm', expected: 'Suspended mass · Displacement' },
            { name: 'Shaker_Table_Disp', unit: 'mm', expected: 'Fixed support · Displacement' },
            { name: 'Shaker_Table_Vel', unit: 'mm/s', expected: 'Fixed support · Velocity' }
        ]
    }
];
