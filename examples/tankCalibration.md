<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Tank Calibration

## Overview

A 50 kg water tank is heated by a 1 kW electric heater and loses heat to the room, but the two numbers that decide how it behaves (how much heat it takes to warm the tank, and how fast it leaks heat away) are not known well. This example is for trying Parameter tuning: the model starts from wrong guesses for both, and eight hours of measured water temperatures are given so that tuning can recover the right values.

## Model structure

- **Water tank:** the water temperature, starting at the room's 293.15 K
- **Electric heater:** a fixed 1 kW heat flow
- **Ambient air:** a fixed 293.15 K temperature boundary
- **Heater input / Ambient heat loss:** the two thermal relationships, both changing the tank's temperature
- **Water thermal capacitance:** one *shared parameter*, used by both relationships, so tuning it changes both at once
- **Heat loss coefficient:** a parameter of the Ambient heat loss relationship

Both unknowns are already marked **Tunable**, with the range each may take: the capacitance between 100,000 and 600,000 J/K, the heat loss coefficient between 2 and 60 W/K. The model starts from guesses of 300,000 J/K and 10 W/K.

## Equations

The tank warms from the heater and exchanges heat with the room:

$$C\dot{T} = Q_{heater} - UA(T-T_{ambient})$$

As the two relationships, each adding to the tank's temperature:

$$\dot{T} = \frac{Q_{heater}}{C} \quad\text{— \textbf{Heater input}}$$

$$\dot{T} = \frac{UA(T_{ambient}-T)}{C} \quad\text{— \textbf{Ambient heat loss}}$$

The tank warms at first at $Q/C$, whatever the loss, and levels off at $T_{ambient} + Q/UA$. So the early part of the measurements says what $C$ is and the late part says what $UA$ is, which is why both can be found from one run.

## Calibrating it

1. **Save the measurements.** Copy the table below into a text file and save it as `tank.csv`. One row is one reading every 10 minutes for eight hours.
2. **Open Parameter tuning** from the toolbar and choose `tank.csv`. The `tankTemperature` column is matched to the tank's *Water temperature* by name, and both unknowns appear as tunable parameters with their ranges.
3. **Run fit.** Before it starts, the card times one simulation and says how long the whole fit should take. While it runs, the plot shows the loss of every simulation tried and the best so far, with the best values found beside it. This model is small, so the default optimiser finishes in a fraction of a second.
4. **Review.** The fitted values should be close to **209,000 J/K** and **20 W/K**, which are what the measurements were made with; the plot compares the measured temperatures with the model's. Press **Apply fitted values** to put them in the model, and run it to see it follow the data.
5. **To watch a longer search,** choose the global optimiser (ISRES) and allow 20,000 simulations. The plot then fills as it searches and the numbers beside it keep moving. Press **Stop and use best so far** whenever you like: the best values found are kept and can be applied, even though the search was cut short.

```csv
time,tankTemperature
0,292.99
600,296.12
1200,298.58
1800,301.30
2400,303.96
3000,306.03
3600,308.22
4200,310.14
4800,311.93
5400,313.77
6000,315.47
6600,317.18
7200,318.41
7800,320.03
8400,321.32
9000,322.45
9600,323.76
10200,324.87
10800,325.97
11400,326.92
12000,327.88
12600,328.69
13200,329.57
13800,330.36
14400,330.98
15000,331.67
15600,332.31
16200,332.99
16800,333.68
17400,334.23
18000,334.51
18600,335.34
19200,335.71
19800,336.24
20400,336.61
21000,336.91
21600,337.06
22200,337.65
22800,337.88
23400,338.14
24000,338.79
24600,338.79
25200,339.00
25800,339.36
26400,339.47
27000,339.52
27600,339.97
28200,339.94
28800,340.30
```

## Expected behaviour

From the starting guesses the model warms too slowly and settles too high, well away from the measurements. After tuning it passes through them to within the readings' noise of about 0.15 K, warming from 293 K to about 340 K by the end of the eight hours and still creeping towards 343 K.

## Try an objective instead

The same card can tune towards a goal rather than towards data. Choose **Optimise an objective**, set the goal to **Maximise**, and write the objective in the editor, which works like an edge's equation: click **final** under Summaries, then click Water tank · Water temperature under States, so it reads as the final value of the water temperature. Set each simulation to run for 28800 s with a 600 s step and run it: the search drives both parameters to their lower bounds, since a smaller thermal mass warms faster and a smaller loss coefficient leaks less heat, and the progress plot shows the final temperature rising rather than a loss falling. Add a limit with the plus beside Limits, such as the max of the water temperature staying at most 340, and run it again to see the search settle just under it. Apply a result only if you want to keep it; the calibrated model is the one to keep.

## Simplifications

The water is perfectly mixed, the room temperature and the heater's power stay fixed, and the measurements are synthetic: the model's own output with the true values, plus a little random noise.
