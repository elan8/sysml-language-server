package DroneLibrary {
    package DroneParts {
        part def Airframe;
        part def PropulsionUnit;
        part def Battery;
        part def GPS;
        part def Camera;
        part def Radio;
    }

    package DroneRequirements {
        requirement <'mass_limit'> MaxTakeoffMass {
            doc /* The drone shall not exceed 5 kg maximum takeoff mass. */
        }

        requirement <'endurance_req'> MinFlightTime {
            doc /* The drone shall be capable of at least 30 minutes of sustained flight. */
        }
    }

    part def SurveillanceQuadrotorDrone {
        part frame : DroneParts::Airframe;
        part propulsion[4] : DroneParts::PropulsionUnit;
        part battery : DroneParts::Battery;
        part gps : DroneParts::GPS;
        part payloadCam : DroneParts::Camera;
        part radioLink : DroneParts::Radio;

        requirement verification massCheck : DroneRequirements::MaxTakeoffMass;
        requirement verification flightTimeCheck : DroneRequirements::MinFlightTime;
    }
}
