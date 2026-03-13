package DroneLibrary {
    package DroneParts {
        part def Airframe;
        part def PropulsionUnit;
        part def Battery;
        part def GPS;
        part def Camera;
        part def Radio;
    }

    part def SurveillanceQuadrotorDrone {
        part frame : DroneParts::Airframe;
        part propulsion[4] : DroneParts::PropulsionUnit;
        part battery : DroneParts::Battery;
        part gps : DroneParts::GPS;
        part payloadCam : DroneParts::Camera;
        part radioLink : DroneParts::Radio;
    }
}
