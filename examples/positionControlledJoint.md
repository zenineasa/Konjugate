<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Position Controlled Joint

## Overview

A joint that tracks a live, scrubbable target angle: a controller reads the joint's own angle and angular velocity and drives the supply voltage that powers its motor, closing the loop entirely through the electrical actuation chain rather than commanding the joint directly. Open the edge editor on Position control (or just watch it run) and move the setpoint slider — the joint visibly settles wherever you put it, smoothly and without overshoot.

## Model structure

- **Voltage source:** starts at 0 V rather than a fixed supply, since Position control drives it directly
- **Motor** and **Joint link:** the same actuator/link pair as Two Link Arm's, using Rotational drive — plus one addition: Joint link carries an extra, example-specific source term for viscous joint friction ($\dot{\omega}_{link} = -10\,\omega_{link}$), needed for the reason explained under Expected behaviour
- **Position control:** reads the link's own angle *and* angular velocity, compares angle to a live `setpointAngle` parameter (starting at 1.2 rad), and feeds both the accumulated error and a damping term into the voltage source

## Equations

### The governing equations

Kirchhoff's voltage law, Newton's second law for the link (driven directly, as in Two Link Arm), and the link's own kinematic relation:

$$V = L\dot{i} + Ri + k_e\omega_{motor} \qquad J\dot{\omega}_{link} = k_t i \qquad \dot{\theta} = \omega_{link}$$

An integral control law, the standard way to write "accumulate the error over time":

$$V = k_i\int(\theta^{*}-\theta)\,dt$$

### As edge and source-term contributions

Differentiating the integral control law lands exactly on Konjugate's rate form — every edge computes a derivative, and $\frac{d}{dt}\!\left[k_i\int e\,dt\right] = k_ie$ needs no extra machinery to fit that:

$$\dot{V}=k_i(\theta^{*}-\theta) \quad\text{— \textbf{Position control}, Joint link → Voltage source}$$

$$\dot{i}=\frac{V-Ri-k_e\omega_{motor}}{L} \quad\text{— \textbf{Armature dynamics}, Voltage source → Motor}$$

$$\dot{\omega}_{link}=\frac{k_t i}{J} \quad\text{— \textbf{Rotational drive}, Motor → Joint link}$$

$$\dot{\theta}=\omega_{link} \quad\text{— self-referencing source term on Joint link}$$

$$\dot{\omega}_{link}\mathrel{{-}{=}}k_d\omega_{link} \quad\text{— a second self-referencing source term on Joint link (see Expected behaviour)}$$

Position control's own rate equation actually carries a second term beyond the pure integral law above — see Expected behaviour for why:

$$\dot{V}=k_i(\theta^{*}-\theta)-k_d'\omega_{link}$$

**States**:

- $\theta$ (`sourceAngle`) and $\omega_{link}$ (`sourceAngularVelocity`) — Joint link's own states, both read by Position control
- $i$ (`sourceCurrent` in Rotational drive; `targetCurrent` in Armature dynamics) — Motor's own current
- $\omega_{motor}$ (`targetAngularVelocity`) — Motor's own angular velocity, read by Armature dynamics for back-EMF but never driven in this model (same gap Two Link Arm documents)
- $V$ (`targetVoltage`) — Voltage source's own state: the output of Position control, and the input Armature dynamics reads

**Parameters**:

- $k_i$ (`gain`), $k_d'$ (`rateGain`), $\theta^{*}$ (`setpointAngle`, live) — Position control
- $R$ (`resistance`), $L$ (`inductance`), $k_e$ (`backEmfConstant`) — Armature dynamics
- $k_t$ (`torqueConstant`), $J$ (`momentOfInertia`) — Rotational drive
- $k_d$, the joint-friction source term's own coefficient (10), is a plain numeric literal in its LaTeX rather than a named parameter — source terms can only bind a node's own states, with no parameter mechanism of their own (unlike edges)

## Expected behaviour

The pure integral law by itself is unstable here — not just "needs a bigger or smaller gain," but structurally unstable for *any* positive gain. Chaining voltage (an integrator of angle error) into current (a damped first-order lag) into angular velocity (a pure integrator of current) into angle (a pure integrator of angular velocity) makes a fourth-order loop with only one damped term in it. Writing out its characteristic polynomial gives $\lambda^4+\frac{R}{L}\lambda^3+\frac{k_ik_t}{JL}=0$ — the $\lambda^2$ and $\lambda^1$ coefficients are exactly zero, which fails the Routh-Hurwitz necessary condition for stability outright. This was confirmed directly, not just derived: the unpatched loop's angle grows into the hundreds of radians within 20 seconds, and running the same model at a 20× smaller timestep reproduces the same divergence almost exactly — proof it's a genuine continuous-time instability, not a numerical artifact a finer timestep could fix.

Two damping terms close the gap: joint friction (the extra source term on Joint link) and rate feedback (Position control's `rateGain` term, reading the link's own angular velocity). Neither alone is sufficient — the same characteristic-polynomial analysis shows friction alone leaves the $\lambda^1$ coefficient at zero, and rate feedback alone leaves $\lambda^2$ at zero — but together they make every coefficient positive, and the specific values shipped here (friction coefficient 10, rate gain 10) sit comfortably inside the stable range that same analysis predicts. With both in place, voltage climbs smoothly from zero, current and angular velocity follow, and angle rises without overshoot to settle at exactly the setpoint (1.2 rad by default) with angular velocity decaying to zero alongside it. Moving the setpoint slider during a run re-opens the error and the joint settles smoothly to the new target.

## Simplifications

Rate feedback is a real, standard technique (the same role a derivative term plays in a PID controller) but naming it as part of an otherwise-"pure integral" story is worth being honest about: this is no longer a pure integral controller, it's an integral-plus-rate one, because the pure form doesn't actually work for a plant this order. The joint friction value and the rate gain were tuned by checking they land inside the analytically-derived stable range, not against a real joint's measured damping — a real robot joint's friction would be measured, not assumed.
