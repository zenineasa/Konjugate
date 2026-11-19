<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Excavator

## Overview

A small excavator's four functions, made to be driven by hand with two joysticks the way an operator drives one: the cab's swing, the boom, the stick and the bucket. Each is a joint whose speed follows a live command from −1 to 1 through the lag of its hydraulics, so a stick held over moves its joint steadily and a stick let go stops it. Where the bucket's tip is, its height above the ground and its reach from the swing axis, is worked out exactly at every step from the four angles. Bind a joystick axis to each command (Settings › Controllers, or Bind… in the live controls during an online run) and dig.

## Model structure

- **Cab:** the swing angle and its speed, following the *Swing command*
- **Boom:** the boom's angle above the horizontal and its speed, following the *Boom command*
- **Stick:** the stick's joint angle (relative to the boom) and its speed, following the *Stick command*, and its absolute angle
- **Bucket:** the bucket's joint angle (relative to the stick) and its speed, following the *Bucket command*, and its absolute angle
- **Stick on boom / Bucket on stick:** relationships that set each part's absolute angle, its joint's angle plus the absolute angle of the part it hangs from
- **Boom reach / Stick reach / Bucket reach:** relationships that set the bucket tip's height and reach, each adding its part's share
- **Bucket tip:** its height (m, 0 is the ground) and its reach (m)

The usual operator layout is: left joystick, left and right to swing, forward and back for the stick; right joystick, forward and back for the boom, left and right for the bucket.

## Equations

Each joint's speed $\omega$ follows its command $u$ (from −1 to 1) towards its top speed $\omega_{max}$, with the hydraulics' lag $\tau$ of 0.3 s, and moves its angle $\theta$:

$$\dot{\omega} = \frac{\omega_{max}\,u - \omega}{\tau} \qquad \dot{\theta} = \omega$$

The top speeds are 0.5 rad/s for the swing, 0.3 for the boom, 0.4 for the stick and 0.6 for the bucket. Each part's absolute angle is set, not integrated:

$$\phi_{boom} = \theta_{boom} \qquad \phi_{stick} = \phi_{boom} + \theta_{stick} \qquad \phi_{bucket} = \phi_{stick} + \theta_{bucket}$$

And the tip's height $h$ and reach $r$, with the boom's pivot 1.8 m up and 0.8 m out, a 5.7 m boom, a 2.9 m stick and a 1.5 m bucket, are the sum of the three parts' shares, each set by its own relationship:

$$h = 1.8 + 5.7\sin\phi_{boom} + 2.9\sin\phi_{stick} + 1.5\sin\phi_{bucket}$$

$$r = 0.8 + 5.7\cos\phi_{boom} + 2.9\cos\phi_{stick} + 1.5\cos\phi_{bucket}$$

## Expected behaviour

With every command centred nothing moves: the tip waits 0.93 m above the ground, 5.52 m out. Held full down, the boom lowers at 0.3 rad/s, reaching full speed within about a second, and the tip touches the ground about a second later, still moving out. Each part keeps its angle relative to the one it hangs from, so lowering the boom carries the stick and the bucket down with it.

## Simplifications

The joints have no end stops, so a function held over long enough turns past where a real machine's cylinders would stop it, and the ground does not push back: a tip below 0 m has dug into it. Each function's speed depends only on its own command, as if the pump had flow to spare for all four at once; a real machine slows when several functions share its pump. The swing turns the whole arm, but the height and reach do not depend on it.
